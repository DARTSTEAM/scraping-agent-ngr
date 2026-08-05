const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * McDonald's Peru own-site scraper.
 * Intercepts catalog API responses, keeps the fullest payload, and filters
 * categories that are inactive or not shown in the live UI nav.
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
            // Prefer non-featured when product counts are close
            if (a.isFeatured !== b.isFeatured && Math.abs(a.productCount - b.productCount) < 10) {
                return a.isFeatured ? 1 : -1;
            }
            return b.productCount - a.productCount || b.data.length - a.data.length;
        });
        let catalogData = scored[0].data;
        console.log(`Catálogo elegido: ${scored[0].url} (${scored[0].data.length} cats, ${scored[0].productCount} productos)`);

        // Visible category labels in the UI nav (if present)
        const visibleCategories = await page.evaluate(() => {
            const labels = new Set();
            const selectors = [
                'nav a', 'nav button', '[role="tab"]', '[role="tablist"] a', '[role="tablist"] button',
                '[class*="categor"] a', '[class*="Categor"] a', '[class*="menu-nav"] a',
                '[class*="sidebar"] a', '[class*="category-list"] a', '[class*="Category"] button',
            ];
            for (const sel of selectors) {
                document.querySelectorAll(sel).forEach(el => {
                    const t = (el.textContent || '').trim();
                    if (t && t.length > 1 && t.length < 60) labels.add(t);
                });
            }
            return [...labels];
        });
        if (visibleCategories.length > 0) {
            console.log(`Categorías visibles en UI: ${visibleCategories.join(', ')}`);
        }

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

            // Drop out-of-daypart clones like "McCombos (Desayuno)" from outdaypart=true
            if (/\(\s*desayuno\s*\)/i.test(title)) {
                droppedCategories.push(`${title} (daypart clone)`);
                continue;
            }

            // Drop categories marked unavailable / closed by schedule
            if (category.available === false || category.isAvailable === false || category.enabled === false) {
                droppedCategories.push(`${title} (unavailable)`);
                continue;
            }
            if (category.isOpen === false || category.open === false) {
                droppedCategories.push(`${title} (cerrada)`);
                continue;
            }

            // Standalone "Desayunos" only during breakfast hours (Lima) or if UI nav shows it
            if (/^desayunos$/i.test(title)) {
                const limaHour = Number(new Date().toLocaleString('en-US', {
                    timeZone: 'America/Lima', hour: 'numeric', hour12: false,
                }));
                const inNav = visibleCategories.some(v => v.toLowerCase() === 'desayunos');
                const breakfastHours = limaHour >= 5 && limaHour < 11;
                if (!breakfastHours && !inNav) {
                    droppedCategories.push(`${title} (fuera de horario)`);
                    continue;
                }
            }

            // If UI nav is present, keep only categories that appear there
            if (visibleCategories.length >= 3) {
                const inNav = visibleCategories.some(v =>
                    v.toLowerCase() === title.toLowerCase() ||
                    v.toLowerCase().includes(title.toLowerCase()) ||
                    title.toLowerCase().includes(v.toLowerCase())
                );
                if (!inNav) {
                    droppedCategories.push(`${title} (no en UI)`);
                    continue;
                }
            }

            for (const product of products) {
                if (product.available === false || product.inStock === false || product.enabled === false) {
                    continue;
                }
                const amount = product.price?.amount ?? product.price ?? 0;
                const price = typeof amount === 'number'
                    ? (amount > 1000 ? amount / 100 : amount)
                    : parseFloat(amount) || 0;
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

        const storeIdMatch = url.match(/\/([^\/]+)\/pedidos/);
        const storeId = storeIdMatch ? `mcd-${storeIdMatch[1]}` : 'mcd-own';

        if (extractedProducts.length === 0) {
            throw new Error('Catálogo interceptado pero sin productos activos tras el filtrado.');
        }

        const catCounts = {};
        extractedProducts.forEach(p => { catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
        console.log(`Productos: ${extractedProducts.length} · Categorías: ${Object.entries(catCounts).map(([k, v]) => `${k}(${v})`).join(', ')}`);

        saveData(extractedProducts, storeId);

    } catch (error) {
        console.error(`Error durante el scraping: ${error.message}`);
        process.exit(1);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }
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

const targetUrl = process.argv[2];
if (targetUrl) {
    scrapeMcDonalds(targetUrl);
} else {
    console.log('Uso: node mcdonalds_scraper.js <URL>');
}
