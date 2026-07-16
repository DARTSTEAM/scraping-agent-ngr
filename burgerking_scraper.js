const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

// Extract products from the article cards currently rendered on the page.
// Runs in the browser context; returns [{name, description, price}].
async function extractProductsOnPage(page) {
    return page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('article'));
        return cards.map(card => {
            const nameEl = card.querySelector('h3, h2, h4');
            const name = nameEl?.textContent?.trim() || '';

            const allPs = Array.from(card.querySelectorAll('p'));
            const descEl = allPs.find(p => !p.textContent.includes('S/'));
            const description = descEl?.textContent?.trim() || '';

            const priceText = card.textContent || '';
            const priceMatches = [...priceText.matchAll(/S\/\s*([\d.,]+)/g)];
            let price = 0;
            if (priceMatches.length > 0) {
                const prices = priceMatches
                    .map(m => parseFloat(m[1].replace(',', '.')))
                    .filter(p => !isNaN(p) && p > 0);
                // Multiple prices on a card = regular + promo → the promo (lowest) is what the client pays
                price = prices.length > 1 ? Math.min(...prices) : (prices[0] || 0);
            }
            return { name, description, price };
        }).filter(p => p.name.length > 0 && p.price > 0);
    });
}

// Scroll to the bottom repeatedly so lazy-loaded product cards all render.
async function autoScroll(page) {
    let prevCount = -1;
    for (let i = 0; i < 15; i++) {
        const count = await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
            return document.querySelectorAll('article').length;
        });
        await page.waitForTimeout(1200);
        if (count === prevCount) break; // no new cards loaded → done
        prevCount = count;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
}

// Scrape every card across a category's pagination, tagging each with `category`.
async function scrapeCategoryPages(page, categoryUrl, categoryName) {
    const out = [];
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
        await page.waitForSelector('article', { timeout: 20000 });
    } catch (_) {
        console.warn(`  ⚠ ${categoryName}: sin artículos, salteando.`);
        return out;
    }
    await page.waitForTimeout(1500);

    // Paginate via the "next" arrow until it disappears/disables.
    for (let guard = 0; guard < 30; guard++) {
        await autoScroll(page); // load lazy cards on this page before reading
        const products = await extractProductsOnPage(page);
        out.push(...products);

        const nextClicked = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, a'));
            const nextBtn = buttons.find(b => {
                const text = b.textContent?.trim();
                const label = (b.getAttribute('aria-label') || '').toLowerCase();
                return (text === '>' || text === '›' || text === '→' || text === '»' ||
                    label.includes('siguiente') || label.includes('next'));
            });
            if (nextBtn && !nextBtn.hasAttribute('disabled') && nextBtn.getAttribute('aria-disabled') !== 'true') {
                nextBtn.click();
                return true;
            }
            return false;
        });
        if (!nextClicked) break;
        await page.waitForTimeout(2500);
    }

    console.log(`  → ${categoryName}: ${out.length} productos`);
    return out.map(p => ({ ...p, category: categoryName, restaurant: 'Burger King' }));
}

/**
 * Burger King Peru scraper — burgerking.pe/carta
 * Discovers per-category routes (/carta/<slug>) from the menu and scrapes each
 * one so every product carries its real category (instead of a single bucket).
 */
async function scrapeBurgerKing(url = 'https://www.burgerking.pe/carta') {
    console.log(`Iniciando scraping de Burger King: ${url}`);
    console.log(`🌐 Conectando al navegador remoto en Kernel (proxy residencial Perú)...`);

    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    let results = [];

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('article', { timeout: 20000 });
        console.log('Página cargada.');
        await page.waitForTimeout(2000);

        // Discover category routes: /carta/<slug>, excluding the flat "ver-todo" view.
        const categories = await page.evaluate(() => {
            const seen = new Map();
            for (const a of document.querySelectorAll('a[href*="/carta/"]')) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/^\/carta\/([a-z0-9-]+)\/?$/i);
                if (!m) continue;
                const slug = m[1].toLowerCase();
                if (slug === 'ver-todo') continue;
                // De-dupe doubled labels ("King Jr.King Jr.") and trim.
                let text = (a.textContent || '').trim();
                const half = text.slice(0, text.length / 2);
                if (text.length % 2 === 0 && half === text.slice(text.length / 2)) text = half;
                if (!seen.has(href) && text) seen.set(href, { href, name: text });
            }
            return [...seen.values()];
        });

        console.log(`Categorías detectadas: ${categories.length} → ${categories.map(c => c.name).join(', ')}`);

        if (categories.length === 0) {
            // Fallback: no category routes found → scrape the flat "ver-todo" view.
            console.warn('No se detectaron categorías; usando /carta/ver-todo como respaldo.');
            results = await scrapeCategoryPages(page, 'https://www.burgerking.pe/carta/ver-todo', 'Ver Todo');
        } else {
            // 1) Per-category pass → real category for each product (name → category).
            const nameToCategory = new Map();
            for (const cat of categories) {
                const catUrl = cat.href.startsWith('http') ? cat.href : `https://www.burgerking.pe${cat.href}`;
                const catProducts = await scrapeCategoryPages(page, catUrl, cat.name);
                for (const p of catProducts) {
                    if (!nameToCategory.has(p.name)) nameToCategory.set(p.name, p.name && cat.name);
                }
            }
            // 2) Full "ver-todo" pass → complete coverage; tag with the mapped category.
            const allProducts = await scrapeCategoryPages(page, 'https://www.burgerking.pe/carta/ver-todo', 'Otros');
            results = allProducts.map(p => ({ ...p, category: nameToCategory.get(p.name) || 'Otros' }));
            console.log(`Cobertura ver-todo: ${allProducts.length} · con categoría mapeada: ${allProducts.filter(p => nameToCategory.has(p.name)).length}`);
        }

    } catch (error) {
        console.error(`Error durante el scraping: ${error.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    // Deduplicate by name + category (same item can legitimately appear in two categories).
    const seen = new Set();
    const unique = results.filter(p => {
        const key = `${p.name}||${p.category}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`\nTotal de productos únicos extraídos: ${unique.length}`);

    if (unique.length > 0) {
        saveData(unique, 'burgerking-pe');
    } else {
        console.error('No se extrajo ningún producto. Revisá los selectores.');
        process.exit(1);
    }

    return unique;
}

function escapeCsv(str) {
    if (str === null || str === undefined) return '';
    return `"${String(str).replace(/"/g, '""')}"`;
}

function saveData(products, storeId) {
    const outDir = path.join(__dirname);

    const jsonPath = path.join(outDir, `products_${storeId}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(products, null, 2));
    console.log(`JSON guardado en: ${jsonPath}`);

    const headers = ['Restaurant', 'Category', 'Product Name', 'Description', 'Price'];
    const rows = products.map(p =>
        [escapeCsv(p.restaurant), escapeCsv(p.category), escapeCsv(p.name), escapeCsv(p.description), p.price].join(',')
    );
    const csvPath = path.join(outDir, `products_${storeId}.csv`);
    fs.writeFileSync(csvPath, [headers.join(','), ...rows].join('\n'));
    console.log(`CSV guardado en: ${csvPath}`);
}

const targetUrl = process.argv[2] || 'https://www.burgerking.pe/carta';
scrapeBurgerKing(targetUrl);
