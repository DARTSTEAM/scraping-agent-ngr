const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

// Prettify a URL slug into a category label: "las-goleadoras" → "Las Goleadoras".
function prettifySlug(slug) {
    return slug.split('-')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

// Extract product cards currently rendered on the page → [{name, description, price}].
async function extractProductsOnPage(page) {
    return page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('article, [class*="product-card"], [class*="ProductCard"], [class*="menu-item"], [class*="MenuItem"]'));
        const items = [];
        const seenEls = new Set();
        for (const el of cards) {
            // Skip cards nested inside another already-processed card
            if (el.parentElement?.closest('article, [class*="product-card"], [class*="ProductCard"], [class*="menu-item"], [class*="MenuItem"]')) continue;
            const nameEl = el.querySelector('h3, h2, h4, [class*="name"], [class*="title"]');
            const name = nameEl?.textContent?.trim() || '';
            if (!name || seenEls.has(name)) continue;

            const descEls = Array.from(el.querySelectorAll('p, [class*="description"], [class*="desc"]'));
            const descEl = descEls.find(p => !p.textContent.includes('S/') && p.textContent.trim().length > 3);
            const description = descEl?.textContent?.trim() || '';

            const priceMatches = [...(el.textContent || '').matchAll(/S\/\s*([\d.,]+)/g)];
            let price = 0;
            if (priceMatches.length > 0) {
                const prices = priceMatches
                    .map(m => parseFloat(m[1].replace(',', '.')))
                    .filter(p => !isNaN(p) && p > 0);
                // regular + promo on one card → promo (lowest) is what the client pays
                price = prices.length > 1 ? Math.min(...prices) : (prices[0] || 0);
            }
            if (price > 0) { items.push({ name, description, price }); seenEls.add(name); }
        }
        return items;
    });
}

// Scroll to load lazy cards.
async function autoScroll(page) {
    let prev = -1;
    for (let i = 0; i < 15; i++) {
        const count = await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
            return document.querySelectorAll('article, [class*="product-card"], [class*="menu-item"]').length;
        });
        await page.waitForTimeout(1200);
        if (count === prev) break;
        prev = count;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
}

// Scrape all cards across a category's pagination, tagging each with `category`.
async function scrapeCategoryPages(page, categoryUrl, categoryName) {
    const out = [];
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    try {
        await page.waitForSelector('article, [class*="product-card"], [class*="menu-item"]', { timeout: 20000 });
    } catch (_) {
        console.warn(`  ⚠ ${categoryName}: sin cards, salteando.`);
        return out;
    }
    await page.waitForTimeout(1500);
    for (let guard = 0; guard < 30; guard++) {
        await autoScroll(page);
        out.push(...await extractProductsOnPage(page));
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
    return out.map(p => ({ ...p, category: categoryName, restaurant: 'Pizza Hut' }));
}

/** Discover Digifood section routes; category name from slug (PH link text is promotional). */
async function discoverSectionCategories(page, section) {
    const cats = await page.evaluate((sec) => {
        const seen = new Map();
        const re = new RegExp(`^\\/${sec}\\/([a-z0-9-]+)\\/?$`, 'i');
        for (const a of document.querySelectorAll(`a[href*="/${sec}/"]`)) {
            const href = a.getAttribute('href') || '';
            const m = href.match(re);
            if (!m) continue;
            const slug = m[1].toLowerCase();
            if (slug === 'ver-todo') continue;
            if (!seen.has(slug)) seen.set(slug, { href, slug });
        }
        return [...seen.values()];
    }, section);
    cats.forEach(c => { c.name = prettifySlug(c.slug); });
    return cats;
}

/**
 * Pizza Hut Peru scraper — pizzahut.com.pe/carta + /promociones
 * Discovers per-category routes and scrapes each so every product carries its
 * real category. Link text is promotional, so category names come from the slug.
 */
async function scrapePizzaHut(url = 'https://www.pizzahut.com.pe/carta') {
    console.log(`Iniciando scraping de Pizza Hut: ${url}`);
    console.log(`🌐 Conectando al navegador remoto en Kernel (proxy residencial Perú)...`);

    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    let results = [];
    const origin = 'https://www.pizzahut.com.pe';

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForSelector('article, [class*="product-card"], [class*="menu-item"]', { timeout: 20000 }).catch(() => {});
        console.log('Página cargada.');
        await page.waitForTimeout(2000);

        const categories = await discoverSectionCategories(page, 'carta');
        console.log(`Categorías Carta: ${categories.length} → ${categories.map(c => c.name).join(', ')}`);

        if (categories.length === 0) {
            console.warn('No se detectaron categorías; usando /carta/ver-todo como respaldo.');
            results = await scrapeCategoryPages(page, `${origin}/carta/ver-todo`, 'General');
        } else {
            const nameToCategory = new Map();
            for (const cat of categories) {
                const catUrl = cat.href.startsWith('http') ? cat.href : `${origin}${cat.href}`;
                const catProducts = await scrapeCategoryPages(page, catUrl, cat.name);
                for (const p of catProducts) if (!nameToCategory.has(p.name)) nameToCategory.set(p.name, cat.name);
            }
            const allProducts = await scrapeCategoryPages(page, `${origin}/carta/ver-todo`, 'Otros');
            results = allProducts.map(p => ({ ...p, category: nameToCategory.get(p.name) || 'Otros' }));
            console.log(`Cobertura ver-todo: ${allProducts.length} · con categoría mapeada: ${allProducts.filter(p => nameToCategory.has(p.name)).length}`);
        }

        // Promociones section (best-effort)
        try {
            await page.goto(`${origin}/promociones`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await page.waitForTimeout(1500);
            const promoCats = await discoverSectionCategories(page, 'promociones');
            console.log(`Categorías Promociones: ${promoCats.length} → ${promoCats.map(c => c.name).join(', ')}`);

            if (promoCats.length > 0) {
                for (const cat of promoCats) {
                    const catUrl = cat.href.startsWith('http') ? cat.href : `${origin}${cat.href}`;
                    results.push(...await scrapeCategoryPages(page, catUrl, cat.name));
                }
            } else {
                const promoProducts = await scrapeCategoryPages(page, `${origin}/promociones`, 'Promociones');
                if (promoProducts.length > 0) results.push(...promoProducts);
                else console.warn('Promociones: sin productos detectados, continuando solo con Carta.');
            }
        } catch (promoErr) {
            console.warn(`Promociones no disponible (${promoErr.message}); continuando solo con Carta.`);
        }

    } catch (error) {
        console.error(`Error durante el scraping: ${error.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    // Deduplicate by name + category
    const seen = new Set();
    const unique = results.filter(p => {
        const key = `${p.name}||${p.category}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`\nTotal de productos únicos extraídos: ${unique.length}`);

    if (unique.length > 0) {
        saveData(unique, 'pizzahut-miraflores');
    } else {
        console.error('No se extrajo ningún producto.');
        process.exit(1);
    }

    return unique;
}

function escapeCsv(str) {
    if (str === null || str === undefined) return '';
    return `"${String(str).replace(/"/g, '""')}"`;
}

function saveData(products, storeId) {
    const jsonPath = path.join(__dirname, `products_${storeId}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(products, null, 2));
    console.log(`JSON guardado en: ${jsonPath}`);

    const headers = ['Restaurant', 'Category', 'Product Name', 'Description', 'Price'];
    const rows = products.map(p =>
        [escapeCsv(p.restaurant), escapeCsv(p.category), escapeCsv(p.name), escapeCsv(p.description), p.price].join(',')
    );
    const csvPath = path.join(__dirname, `products_${storeId}.csv`);
    fs.writeFileSync(csvPath, [headers.join(','), ...rows].join('\n'));
    console.log(`CSV guardado en: ${csvPath}`);
}

const targetUrl = process.argv[2] || 'https://www.pizzahut.com.pe/carta';
scrapePizzaHut(targetUrl);
