const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

const DEFAULT_URL =
  'https://www.mcdonalds.com.pe/restaurantes/lima/benavides-aurora-bau/pedidos';

/**
 * McDonald's Peru own-site scraper.
 * Intercepts catalog API responses and keeps every category with products
 * (no UI-nav / daypart filtering).
 */
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

        // Prefer non-featured full catalog when present; otherwise fullest by product count
        const scored = catalogResponses.map(r => {
            const productCount = r.data.reduce((n, c) => n + (c.products?.length || 0), 0);
            const isFeatured = r.url.includes('featured');
            return { ...r, productCount, isFeatured };
        });
        scored.sort((a, b) => {
            if (a.isFeatured !== b.isFeatured && Math.abs(a.productCount - b.productCount) < 10) {
                return a.isFeatured ? 1 : -1;
            }
            return b.productCount - a.productCount || b.data.length - a.data.length;
        });
        const catalogData = scored[0].data;
        console.log(`Catálogo elegido: ${scored[0].url} (${scored[0].data.length} cats, ${scored[0].productCount} productos)`);

        const restaurantMatch = url.match(/\/restaurantes\/[^\/]+\/([^\/]+)/);
        const restaurantName = restaurantMatch ? `McDonalds ${restaurantMatch[1]}` : 'McDonalds Own';

        const extractedProducts = [];
        const droppedCategories = [];

        for (const category of catalogData) {
            const title = (category.title || category.name || '').trim();
            const products = category.products || [];

            if (!title || products.length === 0) {
                droppedCategories.push(`${title || '(sin título)'} (vacía)`);
                continue;
            }

            // Daypart clones (outdaypart=true) duplicate lunch items under "(Desayuno)".
            if (/\(\s*desayuno\s*\)/i.test(title)) {
                droppedCategories.push(`${title} (daypart clone)`);
                continue;
            }

            for (const product of products) {
                // Keep unavailable items out of pricing, but do not drop whole categories.
                if (product.available === false || product.inStock === false || product.enabled === false) {
                    continue;
                }
                const amount = product.price?.amount ?? product.price ?? 0;
                const price = normalizeMcDPrice(amount);
                if (price === 0) continue;

                extractedProducts.push({
                    restaurant: restaurantName,
                    category: title || 'General',
                    name: product.name || '',
                    description: product.description || '',
                    price,
                    inStock: true,
                });
            }
        }

        if (droppedCategories.length > 0) {
            console.log(`Categorías omitidas: ${droppedCategories.join('; ')}`);
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
    console.log(`Datos guardados en CSV: ${csvPath}`);
}

function escapeCsv(str) {
    if (!str) return '';
    return str.replace(/"/g, '""');
}

const targetUrl = process.argv[2] || DEFAULT_URL;
scrapeMcDonalds(targetUrl);
