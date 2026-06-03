const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * PedidosYa Peru scraper
 * Uses Kernel residential Peru proxy to bypass Cloudflare.
 * Strategy:
 *  1. Intercept XHR/fetch responses with menu data
 *  2. Parse __NEXT_DATA__ from the page
 *  3. DOM fallback
 */
async function scrapePedidosYa(url, storeId = 'mcd-ovalo-gutierrez') {
    console.log(`Iniciando scraping de PedidosYa: ${url}`);
    console.log(`Store ID: ${storeId}`);
    console.log(`🌐 Conectando al navegador remoto en Kernel (proxy residencial Perú)...`);

    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();

    // Extra headers to look more like a real browser
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    });

    const interceptedResponses = [];

    // Intercept any JSON response that might contain menu/section data
    page.on('response', async (response) => {
        const respUrl = response.url();
        const status = response.status();
        if (status !== 200) return;

        const contentType = response.headers()['content-type'] || '';
        if (!contentType.includes('application/json')) return;

        // Target likely API endpoints
        if (
            respUrl.includes('/api/') ||
            respUrl.includes('/sections') ||
            respUrl.includes('/menu') ||
            respUrl.includes('/restaurant') ||
            respUrl.includes('/products') ||
            respUrl.includes('gateway')
        ) {
            try {
                const json = await response.json();
                const urlShort = respUrl.split('?')[0];
                console.log(`[API] Interceptado: ${urlShort}`);
                interceptedResponses.push({ url: respUrl, data: json });
            } catch (_) {}
        }
    });

    try {
        // ── Cloudflare bypass: warm up with homepage first ────────────────
        // Cloudflare blocks cold requests from residential proxies — navigating to
        // the homepage first establishes a session cookie and passes behavioral checks.
        console.log('[PedidosYa] Calentando sesión con homepage...');
        const homeResp = await page.goto('https://www.pedidosya.com.pe/', {
            waitUntil: 'domcontentloaded',
            timeout: 45000,
        });
        console.log(`[PedidosYa] Homepage status: ${homeResp?.status()}`);
        await page.waitForTimeout(4000); // let JS run, cookies settle

        // ── Navigate to restaurant ────────────────────────────────────────
        console.log(`[PedidosYa] Navegando al restaurante: ${url}`);
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

        const httpStatus = resp?.status();
        console.log(`[HTTP] Status de página: ${httpStatus}`);

        if (httpStatus === 403 || httpStatus === 451) {
            throw new Error(`⛔ Bloqueado por Cloudflare (HTTP ${httpStatus}).`);
        }

        // Wait for dynamic content to settle
        await page.waitForTimeout(6000);

        // ── Strategy 1: __NEXT_DATA__ ──────────────────────────────────────
        console.log('[PedidosYa] Buscando __NEXT_DATA__...');
        const nextDataRaw = await page.evaluate(() => {
            const el = document.getElementById('__NEXT_DATA__');
            return el ? el.textContent : null;
        });

        let products = [];
        let restaurantName = storeId;

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

        // ── Strategy 2: intercepted API responses ──────────────────────────
        if (products.length === 0 && interceptedResponses.length > 0) {
            console.log(`[API] Analizando ${interceptedResponses.length} respuestas interceptadas...`);
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

        // ── Strategy 3: DOM scraping ───────────────────────────────────────
        if (products.length === 0) {
            console.log('[DOM] Intentando extracción desde DOM...');
            products = await page.evaluate(() => {
                const items = [];
                const nameEl = document.querySelector('h1, [class*="restaurantName"], [data-testid="restaurant-name"]');
                const restName = nameEl?.textContent?.trim() || 'McDonald\'s Ovalo Gutierrez';

                // Try product cards with multiple selector strategies
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
                    if (items.length > 0) {
                        console.log(`DOM: found ${items.length} items with selector ${sel}`);
                        break;
                    }
                }
                return items;
            });
            console.log(`[DOM] Extraídos ${products.length} productos`);
        }

        if (products.length === 0) {
            // Log first intercepted payload for debugging
            if (interceptedResponses.length > 0) {
                const sample = JSON.stringify(interceptedResponses[0].data).slice(0, 500);
                console.error(`[DEBUG] Primera respuesta interceptada: ${sample}`);
            }
            // Log __NEXT_DATA__ keys for debugging
            if (nextDataRaw) {
                try {
                    const nd = JSON.parse(nextDataRaw);
                    console.error(`[DEBUG] __NEXT_DATA__ pageProps keys: ${Object.keys(nd?.props?.pageProps || {}).join(', ')}`);
                } catch (_) {}
            }
            throw new Error('No se pudo extraer productos de PedidosYa. Ver logs para debug.');
        }

        // Ensure restaurant name is set on all products
        products = products.map(p => ({ ...p, restaurant: p.restaurant || restaurantName }));

        console.log(`✅ ${products.length} productos extraídos de "${restaurantName}"`);
        saveData(products, storeId);

    } catch (error) {
        console.error(`Error: ${error.message}`);
        process.exit(1);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }
}

/**
 * Try to extract products from Next.js SSR data (__NEXT_DATA__).
 * PedidosYa has changed its data structure multiple times — we try several shapes.
 */
function extractFromNextData(nextData) {
    const pageProps = nextData?.props?.pageProps;
    if (!pageProps) return { products: [], restaurantName: '' };

    console.log(`[__NEXT_DATA__] pageProps keys: ${Object.keys(pageProps).join(', ')}`);

    // Shape 1: pageProps.restaurant
    const restaurant = pageProps.restaurant
        || pageProps.restaurantDetailInfo
        || pageProps.data?.restaurant
        || pageProps.initialData?.restaurant;

    if (restaurant) {
        const name = restaurant.name || restaurant.basicData?.name || '';
        const sections = restaurant.menuSections
            || restaurant.sections
            || restaurant.menu?.sections
            || restaurant.menu?.items  // sometimes items directly
            || [];
        const products = flattenSections(sections, name);
        if (products.length > 0) return { products, restaurantName: name };
    }

    // Shape 2: pageProps directly has sections/menu
    const sections = pageProps.sections || pageProps.menuSections || pageProps.menu?.sections;
    if (sections) {
        const name = pageProps.restaurantName || pageProps.name || '';
        return { products: flattenSections(sections, name), restaurantName: name };
    }

    // Shape 3: Deep search for sections array
    const found = deepFind(pageProps, 'sections');
    if (found && Array.isArray(found)) {
        const products = flattenSections(found, '');
        if (products.length > 0) return { products, restaurantName: '' };
    }

    return { products: [], restaurantName: '' };
}

/** Try to extract products from an intercepted API response */
function extractFromApiData(data) {
    if (!data || typeof data !== 'object') return { products: [], restaurantName: '' };

    const name = data.name || data.restaurantName || data.restaurant?.name || '';

    // Look for sections at various depths
    const sections = data.sections || data.menuSections
        || data.data?.sections || data.restaurant?.sections
        || data.menu?.sections || data.result?.sections;

    if (sections && Array.isArray(sections)) {
        return { products: flattenSections(sections, name), restaurantName: name };
    }

    // Look for items directly
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
        const items = section.items || section.products || section.menuItems || [];
        products.push(...itemsToProducts(items, category, restaurantName));
    }
    return products;
}

function itemsToProducts(items, category, restaurantName) {
    return (items || [])
        .filter(item => item && (item.name || item.title))
        .map(item => ({
            restaurant: restaurantName,
            category,
            name: item.name || item.title || '',
            description: item.description || item.desc || '',
            price: parseFloat(item.price || item.unitPrice || item.originalPrice || 0),
            inStock: item.outOfStock !== true && item.available !== false,
        }));
}

/** Recursively search for a key in a nested object */
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
    console.log(`✅ Guardado: ${jsonPath} (${products.length} productos)`);
}

// ── Entry point ──────────────────────────────────────────────────────────────
const targetUrl = process.argv[2];
const targetStoreId = process.argv[3] || 'mcd-ovalo-gutierrez';

if (targetUrl) {
    scrapePedidosYa(targetUrl, targetStoreId);
} else {
    console.log('Uso: node pedidosya_scraper.js <URL> [storeId]');
}
