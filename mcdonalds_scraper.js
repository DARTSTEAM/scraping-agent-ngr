const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const { stamp } = require('./scrape_meta');
const fs = require('fs');
const path = require('path');

const DEFAULT_URL =
  'https://www.mcdonalds.com.pe/restaurantes/lima/benavides-aurora-bau/pedidos';

/**
 * McDonald's Peru own-site scraper.
 * Intercepts every /catalog API response, merges categories from the
 * in-daypart (currently visible) catalogs, and drops breakfast-only
 * sections when they are not in the primary menu.
 */

function categoryTitle(category) {
    return (category.title || category.name || '').trim();
}

function isDaypartCloneTitle(title) {
    return /\(\s*desayuno\s*\)/i.test(title);
}

function isBreakfastCategoryTitle(title) {
    return /^desayunos?$/i.test(title);
}

function catalogFlags(url) {
    return {
        isFeatured: /featured/i.test(url),
        isOutDaypart: /outdaypart=true|out_of_daypart=true|daypart=breakfast/i.test(url),
    };
}

function pickPrimaryCatalog(catalogResponses) {
    const scored = catalogResponses.map(r => {
        const productCount = r.data.reduce((n, c) => n + (c.products?.length || 0), 0);
        return { ...r, productCount, ...catalogFlags(r.url) };
    });
    // McD PE always fetches ?outdaypart=true. Prefer the full menu over featured.
    const preferred = scored.filter(r => !r.isFeatured);
    const list = preferred.length > 0 ? preferred : scored;
    list.sort((a, b) => b.productCount - a.productCount || b.data.length - a.data.length);
    return { primary: list[0], scored };
}

function isPeruBreakfastWindow(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Lima',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find(p => p.type === 'hour')?.value || 0);
    const minute = Number(parts.find(p => p.type === 'minute')?.value || 0);
    return hour * 60 + minute < 11 * 60 + 45;
}

function allowedMcDCategories(scored, primary, now = new Date()) {
    const breakfastActive = isPeruBreakfastWindow(now);
    const allowed = new Set();

    for (const r of scored) {
        for (const category of r.data) {
            const title = categoryTitle(category);
            if (!title || isDaypartCloneTitle(title)) continue;
            if (!(category.products || []).length) continue;
            if (isBreakfastCategoryTitle(title) && !breakfastActive) continue;
            allowed.add(title);
        }
    }

    const dropped = [];
    const seenTitles = new Set();
    for (const r of scored) {
        for (const category of r.data) {
            const title = categoryTitle(category) || '(sin título)';
            if (seenTitles.has(title)) continue;
            seenTitles.add(title);
            if (allowed.has(title)) continue;
            let reason = 'fuera del menú visible';
            if (title === '(sin título)' || !(category.products || []).length) reason = 'vacía';
            else if (isDaypartCloneTitle(title)) reason = 'daypart clone';
            else if (isBreakfastCategoryTitle(title) && !breakfastActive) reason = 'desayuno inactivo';
            dropped.push(`${title} (${reason})`);
        }
    }

    return { allowed, dropped };
}

async function scrapeMcDonalds(url) {
    console.log(`Iniciando scraping de McDonald's (Own): ${url}`);
    console.log(`🌐 Conectando al navegador remoto en Kernel (proxy residencial Perú)...`);

    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    /** @type {{ url: string, data: any[] }[]} */
    const catalogResponses = [];

    page.on('response', async (res) => {
        const resUrl = res.url();
        if (!resUrl.includes('/catalog')) return;
        try {
            const json = await res.json();
            if (Array.isArray(json) && json.length > 0 && json[0] && (json[0].products || json[0].title)) {
                catalogResponses.push({ url: resUrl, data: json });
                console.log(`[McD] Catalog API: ${resUrl} → ${json.length} categorías`);
            }
        } catch (_) {
            // Not JSON
        }
    });

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForTimeout(5000);

        // Scroll a bit to trigger any lazy catalog fetches
        await page.evaluate(async () => {
            window.scrollBy(0, 600);
            await new Promise(r => setTimeout(r, 1000));
            window.scrollTo(0, 0);
        });
        await page.waitForTimeout(2000);

        if (catalogResponses.length === 0) {
            const bodyHtml = await page.evaluate(() => document.body.innerHTML);
            if (!bodyHtml.includes('S/')) {
                throw new Error('No se pudo encontrar el catálogo por API o en la pantalla. Posible bloqueo de Cloudflare.');
            }
            throw new Error('Se cargó la página pero no se detectaron llamadas API válidas de catálogo.');
        }

        const { primary, scored } = pickPrimaryCatalog(catalogResponses);
        const { allowed, dropped } = allowedMcDCategories(scored, primary);
        console.log(`Catálogo primario: ${primary.url} (${primary.data.length} cats, ${primary.productCount} productos)`);
        console.log(`Categorías visibles (merge): ${[...allowed].join(', ') || '(ninguna)'}`);
        if (dropped.length > 0) {
            console.log(`Categorías omitidas: ${dropped.join('; ')}`);
        }

        const restaurantMatch = url.match(/\/restaurantes\/[^\/]+\/([^\/]+)/);
        const restaurantName = restaurantMatch ? `McDonalds ${restaurantMatch[1]}` : 'McDonalds Own';

        const extractedProducts = [];
        const seen = new Set();
        const ordered = [primary, ...scored.filter(r => r.url !== primary.url)];

        for (const response of ordered) {
            for (const category of response.data) {
                const title = categoryTitle(category);
                if (!allowed.has(title)) continue;

                for (const product of category.products || []) {
                    if (product.available === false || product.inStock === false || product.enabled === false) {
                        continue;
                    }
                    const name = product.name || '';
                    const key = `${name}||${title}`;
                    if (!name || seen.has(key)) continue;

                    const amount = product.price?.amount ?? product.price ?? 0;
                    const price = normalizeMcDPrice(amount);
                    if (price === 0) continue;

                    seen.add(key);
                    extractedProducts.push({
                        restaurant: restaurantName,
                        category: title,
                        name,
                        description: product.description || '',
                        price,
                        inStock: true,
                    });
                }
            }
        }

        const storeIdMatch = url.match(/\/([^\/]+)\/pedidos\/?$/);
        const storeId = storeIdMatch ? `mcd-${storeIdMatch[1]}` : 'mcd-own';

        if (extractedProducts.length === 0) {
            throw new Error('Catálogo interceptado pero sin productos con precio tras el filtrado.');
        }

        const catCounts = {};
        extractedProducts.forEach(p => { catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
        console.log(`Productos: ${extractedProducts.length} · Categorías (${Object.keys(catCounts).length}): ${Object.entries(catCounts).map(([k, v]) => `${k}(${v})`).join(', ')}`);

        saveData(extractedProducts, storeId);

    } catch (error) {
        console.error(`Error durante el scraping: ${error.message}`);
        process.exit(1);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }
}

/**
 * McD PE ecommerce mixes soles floats (19.9) and integer cents (990 → 9.90).
 * Integers ≥ 100 are always cents; smaller integers are already soles.
 */
function normalizeMcDPrice(amount) {
    const n = typeof amount === 'number' ? amount : parseFloat(amount);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (Number.isInteger(n) && n >= 100) return n / 100;
    return n;
}

function saveData(products, storeId) {
    const jsonPath = path.join(__dirname, `products_${storeId}.json`);
    const csvPath = path.join(__dirname, `products_${storeId}.csv`);

    fs.writeFileSync(jsonPath, JSON.stringify(products, null, 2));
    console.log(`Datos guardados en JSON: ${jsonPath}`);

    const csvHeader = 'Restaurant,Category,Name,Description,Price\n';
    const csvRows = products.map(p => {
        return `"${escapeCsv(p.restaurant)}","${escapeCsv(p.category)}","${escapeCsv(p.name)}","${escapeCsv(p.description)}",${p.price}`;
    }).join('\n');

    fs.writeFileSync(csvPath, csvHeader + csvRows);
    stamp(storeId);
    console.log(`Datos guardados en CSV: ${csvPath}`);
}

function escapeCsv(str) {
    if (!str) return '';
    return str.replace(/"/g, '""');
}

module.exports = {
    scrapeMcDonalds,
    pickPrimaryCatalog,
    allowedMcDCategories,
    isPeruBreakfastWindow,
    isBreakfastCategoryTitle,
    categoryTitle,
};

if (require.main === module) {
    const targetUrl = process.argv[2] || DEFAULT_URL;
    scrapeMcDonalds(targetUrl);
}
