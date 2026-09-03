const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const { stamp } = require('./scrape_meta');
const fs = require('fs');
const path = require('path');

/**
 * PedidosYa Peru scraper
 * Uses Kernel residential Peru proxy.
 *
 * PedidosYa requires a geo context (lat/lng) before restaurant deep links work.
 * Strategy:
 *  1. Warm session with a Miraflores shoplist URL (sets location cookies)
 *  2. Open restaurant menu page
 *  3. Prefer intercepted /v2/niles/partners/{id}/menus JSON
 *  4. Fallbacks: __NEXT_DATA__, then DOM
 */

const DEFAULT_URL =
  'https://www.pedidosya.com.pe/restaurantes/lima/mcdonalds-ovalo-gutierrez-e6b6652e-45c6-44f7-8976-e376edf475a8-menu';

const GEO_WARM_URL =
  'https://www.pedidosya.com.pe/restaurantes?lat=-12.1118&lng=-77.0355&address=Ovalo%20Gutierrez%20Miraflores&city=Lima';

async function scrapePedidosYa(url = DEFAULT_URL, storeId = 'mcd-ovalo-gutierrez') {
    console.log(`Iniciando scraping de PedidosYa: ${url}`);
    console.log(`Store ID: ${storeId}`);
    console.log(`🌐 Conectando al navegador remoto en Kernel (proxy residencial Perú)...`);

    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();

    await page.setExtraHTTPHeaders({
        'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });

    const interceptedResponses = [];

    try {
        console.log('[PedidosYa] Calentando sesión...');
        // Prefer homepage first — geo shoplist is more likely to trip PX after bursts
        let warmResp = await page.goto('https://www.pedidosya.com.pe/', {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        console.log(`[PedidosYa] Home status: ${warmResp?.status()}`);
        await page.waitForTimeout(4000);

        warmResp = await page.goto(GEO_WARM_URL, {
            waitUntil: 'domcontentloaded',
            timeout: 60000,
        });
        console.log(`[PedidosYa] Warm status: ${warmResp?.status()} → ${page.url()}`);
        await page.waitForTimeout(3000);

        const bodyWarm = await page.evaluate(() => (document.body?.innerText || '').slice(0, 200));
        if (/acceso ha sido denegado|confirma que eres un humano/i.test(bodyWarm) || warmResp?.status() === 403) {
            throw new Error('⛔ Bloqueado por Cloudflare en warm-up.');
        }

        console.log(`[PedidosYa] Navegando al restaurante: ${url}`);

        // Wait for the natural menus API BEFORE navigation (avoid hardcoding partner IDs)
        const menuWait = page.waitForResponse(
            (r) => {
                if (!/\/v2\/niles\/partners\/\d+\/menus/i.test(r.url())) return false;
                const ct = r.headers()['content-type'] || '';
                return r.status() === 200 && ct.includes('json');
            },
            { timeout: 45000 }
        ).catch(() => null);

        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        const httpStatus = resp?.status();
        console.log(`[HTTP] Status: ${httpStatus} → ${page.url()}`);

        if (httpStatus === 403 || httpStatus === 451) {
            throw new Error(`⛔ Bloqueado por Cloudflare (HTTP ${httpStatus}).`);
        }

        await page.waitForFunction(
            () => /S\/\s*\d/.test(document.body?.innerText || '') || !!document.querySelector('h1'),
            { timeout: 30000 }
        ).catch(() => {});

        let menuJson = null;
        const menuResp = await menuWait;
        if (menuResp) {
            try {
                const json = await menuResp.json();
                if (json?.sections) {
                    menuJson = json;
                    console.log(`[API] Menú natural: ${menuResp.url().split('?')[0]} · sections=${json.sections.length}`);
                }
            } catch (e) {
                console.warn(`[API] No se pudo leer menú natural: ${e.message}`);
            }
        }

        // If natural request missed, discover partner id from page and fetch once
        if (!menuJson) {
            const partnerId = await page.evaluate(() => {
                const html = document.documentElement.innerHTML;
                const patterns = [
                    /\/v2\/niles\/partners\/(\d+)\/menus/,
                    /"partnerId"\s*:\s*"?(\d{4,})"?/,
                    /"vendorId"\s*:\s*"?(\d{4,})"?/,
                    /"restaurantId"\s*:\s*"?(\d{4,})"?/,
                    /partners%2F(\d+)%2Fmenus/,
                ];
                for (const re of patterns) {
                    const m = html.match(re);
                    if (m) return m[1];
                }
                return null;
            });
            if (partnerId) {
                console.log(`[API] partnerId descubierto en página: ${partnerId}`);
                const result = await page.evaluate(async (pid) => {
                    const res = await fetch(`/v2/niles/partners/${pid}/menus`, {
                        credentials: 'include',
                        headers: { Accept: 'application/json' },
                    });
                    if (!res.ok) return { error: `HTTP ${res.status}` };
                    const ct = res.headers.get('content-type') || '';
                    if (!ct.includes('json')) {
                        const text = await res.text();
                        return { error: `non-json (${ct}): ${text.slice(0, 80)}` };
                    }
                    return { data: await res.json() };
                }, partnerId);
                if (result?.data?.sections) {
                    menuJson = result.data;
                    console.log(`[API] OK fetch partner=${partnerId} sections=${menuJson.sections.length}`);
                } else {
                    console.warn(`[API] fetch falló: ${result?.error || 'sin sections'}`);
                }
            } else {
                console.warn('[API] No se encontró partnerId en la página');
            }
        }

        if (menuJson) {
            interceptedResponses.push({ url: `menus:/v2/niles/partners/menus`, data: menuJson });
        }

        await page.waitForTimeout(500);

        let products = [];
        let restaurantName = storeId;

        // Strategy 1: intercepted menus API (preferred)
        const menuResponses = interceptedResponses.filter(r => /\/menus/.test(r.url) || r.data?.sections);
        if (menuResponses.length > 0) {
            console.log(`[API] Analizando ${menuResponses.length} respuestas de menú...`);
            for (const { url: apiUrl, data } of menuResponses) {
                const result = extractFromApiData(data);
                if (result.products.length > 0) {
                    products = result.products;
                    restaurantName = result.restaurantName || restaurantName;
                    console.log(`[API] Extraídos ${products.length} productos desde: ${apiUrl.split('?')[0]}`);
                    break;
                }
            }
        }

        // Strategy 2: __NEXT_DATA__
        if (products.length === 0) {
            console.log('[PedidosYa] Buscando __NEXT_DATA__...');
            const nextDataRaw = await page.evaluate(() => {
                const el = document.getElementById('__NEXT_DATA__');
                return el ? el.textContent : null;
            });
            if (nextDataRaw) {
                try {
                    const nextData = JSON.parse(nextDataRaw);
                    const result = extractFromNextData(nextData);
                    products = result.products;
                    restaurantName = result.restaurantName || restaurantName;
                    console.log(`[__NEXT_DATA__] Extraídos ${products.length} productos`);
                } catch (e) {
                    console.warn(`[__NEXT_DATA__] Error parseando: ${e.message}`);
                }
            }
        }

        // Strategy 3: remaining intercepted JSON
        if (products.length === 0 && interceptedResponses.length > 0) {
            for (const { url: apiUrl, data } of interceptedResponses) {
                const result = extractFromApiData(data);
                if (result.products.length > 0) {
                    products = result.products;
                    restaurantName = result.restaurantName || restaurantName;
                    console.log(`[API] Extraídos ${products.length} productos desde: ${apiUrl.split('?')[0]}`);
                    break;
                }
            }
        }

        // Strategy 4: DOM
        if (products.length === 0) {
            console.log('[DOM] Intentando extracción desde DOM...');
            products = await extractFromDom(page);
            console.log(`[DOM] Extraídos ${products.length} productos`);
        }

        if (products.length === 0) {
            if (interceptedResponses.length > 0) {
                const sample = JSON.stringify(interceptedResponses[0].data).slice(0, 500);
                console.error(`[DEBUG] Primera respuesta interceptada: ${sample}`);
            }
            throw new Error('No se pudo extraer productos de PedidosYa. Ver logs para debug.');
        }

        // Drop zero-price rows unless they are the only signal (usually incomplete options)
        const withPrice = products.filter(p => p.price > 0);
        if (withPrice.length > 0) products = withPrice;

        products = products.map(p => ({ ...p, restaurant: p.restaurant || restaurantName }));

        const catCounts = {};
        products.forEach(p => { catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
        console.log(`✅ ${products.length} productos · categorías: ${Object.entries(catCounts).map(([k, v]) => `${k}(${v})`).join(', ')}`);
        saveData(products, storeId);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }
}

function extractFromNextData(nextData) {
    const pageProps = nextData?.props?.pageProps;
    if (!pageProps) return { products: [], restaurantName: '' };

    console.log(`[__NEXT_DATA__] pageProps keys: ${Object.keys(pageProps).join(', ')}`);

    const restaurant = pageProps.restaurant
        || pageProps.restaurantDetailInfo
        || pageProps.data?.restaurant
        || pageProps.initialData?.restaurant;

    if (restaurant) {
        const name = restaurant.name || restaurant.basicData?.name || '';
        const sections = restaurant.menuSections
            || restaurant.sections
            || restaurant.menu?.sections
            || restaurant.menu?.items
            || [];
        const products = flattenSections(sections, name);
        if (products.length > 0) return { products, restaurantName: name };
    }

    const sections = pageProps.sections || pageProps.menuSections || pageProps.menu?.sections;
    if (sections) {
        const name = pageProps.restaurantName || pageProps.name || '';
        return { products: flattenSections(sections, name), restaurantName: name };
    }

    const found = deepFind(pageProps, 'sections');
    if (found && Array.isArray(found)) {
        const products = flattenSections(found, '');
        if (products.length > 0) return { products, restaurantName: '' };
    }

    return { products: [], restaurantName: '' };
}

function extractFromApiData(data) {
    if (!data || typeof data !== 'object') return { products: [], restaurantName: '' };

    const name = data.name || data.restaurantName || data.restaurant?.name || '';

    const sections = data.sections || data.menuSections
        || data.data?.sections || data.restaurant?.sections
        || data.menu?.sections || data.result?.sections;

    if (sections && Array.isArray(sections)) {
        return { products: flattenSections(sections, name), restaurantName: name };
    }

    const items = data.items || data.products || data.data?.items;
    if (items && Array.isArray(items) && items.length > 0 && items[0].name) {
        return { products: itemsToProducts(items, 'General', name), restaurantName: name };
    }

    return { products: [], restaurantName: '' };
}

function flattenSections(sections, restaurantName) {
    const products = [];
    for (const section of (sections || [])) {
        const category = section.name || section.title || 'General';
        const items = section.products || section.items || section.menuItems || [];
        products.push(...itemsToProducts(items, category, restaurantName));
    }
    return products;
}

function parsePrice(item) {
    const raw = item?.price;
    if (typeof raw === 'number') return raw;
    if (raw && typeof raw === 'object') {
        const n = raw.finalPrice ?? raw.originalPrice ?? raw.amount ?? raw.value;
        if (typeof n === 'number') return n;
        if (typeof n === 'string') return parseFloat(n.replace(/[^\d.]/g, '')) || 0;
    }
    if (typeof item.unitPrice === 'number') return item.unitPrice;
    if (typeof item.originalPrice === 'number') return item.originalPrice;
    if (typeof raw === 'string') return parseFloat(raw.replace(/[^\d.]/g, '')) || 0;
    return 0;
}

function itemsToProducts(items, category, restaurantName) {
    return (items || [])
        .filter(item => item && (item.name || item.title))
        .filter(item => item.enabled !== false && item.available !== false && item.outOfStock !== true)
        .map(item => ({
            restaurant: restaurantName,
            category,
            name: item.name || item.title || '',
            description: item.description || item.desc || '',
            price: parsePrice(item),
            inStock: true,
        }));
}

async function extractFromDom(page) {
    return page.evaluate(() => {
        const items = [];
        const nameEl = document.querySelector('h1, [class*="restaurantName"], [data-testid="restaurant-name"]');
        const restName = nameEl?.textContent?.trim() || "McDonald's Ovalo Gutierrez";

        const cardSelectors = [
            '[data-testid="product-card"]',
            '[class*="ProductCard"]',
            '[class*="product-card"]',
            '[class*="MenuItem"]',
            '[class*="menu-item"]',
        ];
        for (const sel of cardSelectors) {
            const els = document.querySelectorAll(sel);
            if (els.length === 0) continue;
            els.forEach(el => {
                const nameEl2 = el.querySelector('[data-testid="product-name"], [class*="productName"], [class*="ProductName"], h3, h4');
                const descEl = el.querySelector('[data-testid="product-description"], [class*="description"]');
                const priceEl = el.querySelector('[data-testid="product-price"], [class*="price"], [class*="Price"]');
                const name = nameEl2?.textContent?.trim() || '';
                const description = descEl?.textContent?.trim() || '';
                const priceText = priceEl?.textContent?.trim() || '0';
                const price = parseFloat(priceText.replace(/[^\d.]/g, '')) || 0;
                if (name) items.push({ restaurant: restName, category: 'General', name, description, price, inStock: true });
            });
            if (items.length > 0) break;
        }
        return items;
    });
}

function deepFind(obj, key, depth = 0) {
    if (depth > 6 || !obj || typeof obj !== 'object') return null;
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
        const result = deepFind(v, key, depth + 1);
        if (result) return result;
    }
    return null;
}

function saveData(products, storeId) {
    const jsonPath = path.join(__dirname, `products_${storeId}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(products, null, 2));
    stamp(storeId);
    console.log(`✅ Guardado: ${jsonPath} (${products.length} productos)`);
}

module.exports = { scrapePedidosYa, DEFAULT_URL };

if (require.main === module) {
    const targetUrl = process.argv[2] || DEFAULT_URL;
    const targetStoreId = process.argv[3] || 'mcd-ovalo-gutierrez';
    scrapePedidosYa(targetUrl, targetStoreId);
}
