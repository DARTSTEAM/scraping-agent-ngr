const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * Generic Digifood-platform scraper — handles:
 *   Wanta      → wanta.pe/carta/ver-todo       storeId: wanta-pe
 *   Chifa Express → chifaexpress.pe/pedir       storeId: chifaexpress-pe
 *   Cinnabon   → cinnabon.com.pe/pedir          storeId: cinnabon-pe
 *
 * These all share the same Digifood frontend as Burger King Peru.
 * Always takes the CURRENT price, not promotional crossed-out prices.
 */
async function scrapeDigifood(url, restaurantName, storeId) {
    console.log(`Iniciando scraping de ${restaurantName}: ${url}`);
    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    let results = [];
    const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('article', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // On /carta sites (Wanta & other BK-style Digifood menus) each category is a
        // route /carta/<slug>. Scrape per-category so products carry a real category.
        const categories = await page.evaluate(() => {
            const seen = new Map();
            for (const a of document.querySelectorAll('a[href*="/carta/"]')) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/^\/carta\/([a-z0-9-]+)\/?$/i);
                if (!m || m[1].toLowerCase() === 'ver-todo') continue;
                let text = (a.textContent || '').trim();
                const half = text.slice(0, text.length / 2);
                if (text.length % 2 === 0 && half === text.slice(text.length / 2)) text = half; // de-double
                if (!seen.has(href) && text) seen.set(href, { href, name: text });
            }
            return [...seen.values()];
        });

        if (categories.length > 0 && origin) {
            console.log(`Categorías detectadas: ${categories.length} → ${categories.map(c => c.name).join(', ')}`);
            const nameToCategory = new Map();
            for (const cat of categories) {
                const catUrl = cat.href.startsWith('http') ? cat.href : `${origin}${cat.href}`;
                const catProducts = await scrapeCategoryPage(page, catUrl, cat.name, restaurantName);
                console.log(`  → ${cat.name}: ${catProducts.length} productos`);
                for (const p of catProducts) if (!nameToCategory.has(p.name)) nameToCategory.set(p.name, cat.name);
            }
            // Full ver-todo pass for coverage; tag with the mapped category.
            const all = await scrapeCategoryPage(page, `${origin}/carta/ver-todo`, 'Otros', restaurantName);
            results = all.map(p => ({ ...p, category: nameToCategory.get(p.name) || 'Otros' }));
            console.log(`Cobertura ver-todo: ${all.length} · con categoría mapeada: ${all.filter(p => nameToCategory.has(p.name)).length}`);
        } else {
            // /pedir sites (Chifa Express, Cinnabon): flat paginated flow.
            let totalPages = 1;
            try {
                const pageNums = await page.$$eval(
                    'nav button, [class*="pagination"] button, [class*="pager"] button',
                    btns => btns.map(b => parseInt(b.textContent?.trim())).filter(n => !isNaN(n) && n > 0)
                );
                if (pageNums.length > 0) totalPages = Math.max(...pageNums);
            } catch (_) {}

            console.log(`Total de páginas: ${totalPages}`);
            for (let p = 1; p <= totalPages; p++) {
                console.log(`Procesando página ${p} de ${totalPages}...`);
                await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
                await autoScroll(page);
                const pageProducts = await extractProducts(page, restaurantName);
                console.log(`  → ${pageProducts.length} productos en página ${p}`);
                results.push(...pageProducts);
                if (p < totalPages) {
                    const clicked = await clickNext(page);
                    if (!clicked) break;
                    await page.waitForTimeout(3000);
                }
            }
        }

    } catch (err) {
        console.error(`Error: ${err.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    return saveUnique(results, storeId, restaurantName);
}

// Navigate to a category route, load all cards, and return its products.
async function scrapeCategoryPage(page, categoryUrl, categoryName, restaurantName) {
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('article', { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const out = [];
    for (let guard = 0; guard < 30; guard++) {
        await autoScroll(page);
        const products = await extractProducts(page, restaurantName);
        out.push(...products.map(p => ({ ...p, category: categoryName })));
        const clicked = await clickNext(page);
        if (!clicked) break;
        await page.waitForTimeout(2500);
    }
    // de-dupe within the category by name
    const seen = new Set();
    return out.filter(p => (seen.has(p.name) ? false : (seen.add(p.name), true)));
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise(resolve => {
            let y = 0;
            const t = setInterval(() => {
                window.scrollBy(0, 400);
                y += 400;
                if (y >= document.body.scrollHeight) { clearInterval(t); resolve(); }
            }, 300);
        });
        window.scrollTo(0, 0);
    });
    await page.waitForTimeout(800);
}

async function clickNext(page) {
    return page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, a'));
        const next = buttons.find(b => {
            const txt = b.textContent?.trim();
            const lbl = b.getAttribute('aria-label') || '';
            return txt === '>' || txt === '›' || txt === '→' || txt === '»' ||
                lbl.toLowerCase().includes('siguiente') || lbl.toLowerCase().includes('next');
        });
        if (next && !next.hasAttribute('disabled')) { next.click(); return true; }
        return false;
    });
}

async function extractProducts(page, restaurantName) {
    return page.evaluate((name) => {
        const results = [];
        let currentCategory = 'General';

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
            const el = walker.currentNode;

            // Track category from H1/H2 outside of article
            if ((el.tagName === 'H1' || el.tagName === 'H2') && !el.closest('article')) {
                const txt = el.textContent?.trim();
                if (txt && txt.length > 1 && txt.length < 80) currentCategory = txt;
            }

            if (el.tagName !== 'ARTICLE') continue;

            const nameEl = el.querySelector('h3, h2, h4');
            const productName = nameEl?.textContent?.trim() || '';
            if (!productName) continue;

            // Identify strikethrough (promotional old) prices
            const strikeEls = el.querySelectorAll('del, s, [class*="line-through"], [class*="old-price"], [class*="original"], [class*="tachado"], [class*="before"]');
            const strikedPrices = new Set();
            strikeEls.forEach(se => {
                const m = se.textContent.match(/[\d.,]+/);
                if (m) strikedPrices.add(parseFloat(m[0].replace(',', '.')));
            });

            // Extract all S/ prices from the card and exclude crossed-out ones
            const priceMatches = [...el.textContent.matchAll(/S\/\s*([\d.,]+)/g)];
            const validPrices = priceMatches
                .map(m => parseFloat(m[1].replace(',', '.')))
                .filter(p => !isNaN(p) && p > 0 && !strikedPrices.has(p));

            const price = validPrices.length > 0 ? validPrices[0] : 0;
            if (price === 0) continue;

            const allPs = Array.from(el.querySelectorAll('p'));
            const descEl = allPs.find(p => !p.textContent.includes('S/'));
            const description = descEl?.textContent?.trim() || '';

            results.push({ restaurant: name, category: currentCategory, name: productName, description, price });
        }
        return results;
    }, restaurantName);
}

function saveUnique(results, storeId, restaurantName) {
    const seen = new Set();
    const unique = results.filter(p => {
        const key = `${p.name}||${p.category || ''}`;
        if (!p.name || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`\nTotal de productos únicos extraídos (${restaurantName}): ${unique.length}`);
    if (unique.length > 0) {
        fs.writeFileSync(path.join(__dirname, `products_${storeId}.json`), JSON.stringify(unique, null, 2));
        const header = 'Restaurant,Category,Product Name,Description,Price';
        const rows = unique.map(p => [esc(p.restaurant), esc(p.category), esc(p.name), esc(p.description), p.price].join(','));
        fs.writeFileSync(path.join(__dirname, `products_${storeId}.csv`), [header, ...rows].join('\n'));
        console.log(`Guardado: products_${storeId}.json / .csv`);
    } else {
        console.error('No se extrajo ningún producto.');
        process.exit(1);
    }
    return unique;
}

function esc(str) {
    if (!str) return '""';
    return `"${String(str).replace(/"/g, '""')}"`;
}

// Dispatch based on URL
const targetUrl = process.argv[2] || '';
if (!targetUrl) {
    console.error('Usage: node digifood_scraper.js <url>');
    process.exit(1);
}

let restaurantName = 'Restaurant';
let storeId = 'digifood';

if (targetUrl.includes('wanta.pe')) {
    restaurantName = 'Wanta';
    storeId = 'wanta-pe';
} else if (targetUrl.includes('chifaexpress.pe')) {
    restaurantName = 'Chifa Express';
    storeId = 'chifaexpress-pe';
} else if (targetUrl.includes('cinnabon.com.pe')) {
    restaurantName = 'Cinnabon';
    storeId = 'cinnabon-pe';
}

scrapeDigifood(targetUrl, restaurantName, storeId);
