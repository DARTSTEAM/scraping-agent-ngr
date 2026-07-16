const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * Rokys Peru scraper — rokys.com/menu
 * Uses a standard menu SPA. Extracts current prices only.
 */
async function scrapeRokys(url = 'https://rokys.com/menu') {
    console.log(`Iniciando scraping de Rokys: ${url}`);
    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    let results = [];

    // Rokys' own menu (rokys.com/menu) is a custom Tailwind SPA: products render as
    // `div.cursor-pointer.grid` cards (no <article>, no product data in __NEXT_DATA__).
    // Categories are a horizontal tab bar. We click each tab and scrape its cards.
    const KNOWN_CATEGORIES = ['Promociones', 'Brasas', 'Broaster', 'Parrillas', 'Fusión Criolla',
        'Hamburguesas', 'Piqueos', 'Desayunos', 'Bebidas', "Cyber Roky's"];

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(4000);
        await autoScroll(page);

        // Baseline: everything currently rendered (full catalogue).
        const allCards = await extractRokysCards(page);
        console.log(`Cards totales en la página: ${allCards.length}`);

        // Products live in category sections down the page (the tabs only scroll, they
        // don't filter). Assign each card the category section header directly above it,
        // matched by vertical position — ignoring the sticky tab bar near the top.
        const nameToCategory = await categoriesByPosition(page, KNOWN_CATEGORIES);
        const catCount = new Set(Object.values(nameToCategory)).size;
        console.log(`Categorías mapeadas por posición: ${catCount}`);

        results = allCards.map(c => ({
            restaurant: 'Rokys',
            category: nameToCategory[c.name] || 'General',
            name: c.name,
            description: c.description || '',
            price: c.price,
            ...(c.oldPrice && c.oldPrice > c.price ? { originalPrice: c.oldPrice } : {}),
        }));

        // Last-resort fallback if the new extractor found nothing.
        if (results.length === 0) {
            await autoScroll(page);
            results = await extractProductsDOM(page, 'Rokys');
        }

    } catch (err) {
        console.error(`Error: ${err.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    return saveUnique(results, 'rokys-pe');
}

// Extract Rokys product cards. Discards struck-through (old) prices as `oldPrice`
// and never mistakes a discount badge for a product.
async function extractRokysCards(page) {
    return page.evaluate(() => {
        const cards = [...document.querySelectorAll('div[class*="cursor-pointer"]')]
            .filter(el => /S\/\s*\d/.test(el.textContent || '') && el.querySelector('[class*="font-bold"]'));
        const out = [];
        const seen = new Set();
        for (const el of cards) {
            // keep only outermost card (skip nested cursor-pointer wrappers)
            if (cards.some(o => o !== el && o.contains(el))) continue;

            const nameEl = [...el.querySelectorAll('[class*="font-bold"]')]
                .find(n => !/S\/\s*\d/.test(n.textContent) && !/^-?\s?\d{1,3}\s?%$/.test(n.textContent.trim()) && n.textContent.trim().length > 1);
            const name = nameEl?.textContent?.trim() || '';
            if (!name || seen.has(name)) continue;

            // struck-through original price → oldPrice
            let oldPrice = null;
            const strikeEl = el.querySelector('[class*="line-through"]');
            if (strikeEl) { const m = strikeEl.textContent.match(/([\d.,]+)/); if (m) oldPrice = parseFloat(m[0].replace(',', '.')); }

            // current price: first S/ value that isn't the struck-through one
            const values = [...(el.textContent || '').matchAll(/S\/\s*([\d.,]+)/g)]
                .map(m => parseFloat(m[1].replace(',', '.')))
                .filter(v => !isNaN(v) && v > 0 && v !== oldPrice);
            const price = values[0] || 0;
            if (price === 0) continue;

            const descEl = el.querySelector('p, [class*="desc"]');
            const description = descEl?.textContent?.trim() || '';

            out.push({ name, price, oldPrice, description });
            seen.add(name);
        }
        return out;
    });
}

// Map each product name → its category by vertical position: the category section
// header directly above the card. The sticky tab bar (all categories clustered near
// the top) is ignored by preferring, per category, the LOWEST element on the page
// (the real section header sits far below the tab bar).
async function categoriesByPosition(page, cats) {
    return page.evaluate((categories) => {
        const docY = el => el.getBoundingClientRect().top + window.scrollY;

        // Section header per category = the matching leaf element with the greatest Y.
        const headerY = {};
        for (const el of document.querySelectorAll('h1,h2,h3,h4,p,span,div,a,button,li')) {
            if (el.children.length > 2) continue;
            const t = (el.textContent || '').trim();
            if (!categories.includes(t)) continue;
            const y = docY(el);
            if (headerY[t] === undefined || y > headerY[t]) headerY[t] = y;
        }
        const headers = Object.entries(headerY).map(([name, y]) => ({ name, y })).sort((a, b) => a.y - b.y);

        const map = {};
        const cards = [...document.querySelectorAll('div[class*="cursor-pointer"]')]
            .filter(el => /S\/\s*\d/.test(el.textContent || '') && el.querySelector('[class*="font-bold"]'));
        for (const el of cards) {
            if (cards.some(o => o !== el && o.contains(el))) continue;
            const nameEl = [...el.querySelectorAll('[class*="font-bold"]')]
                .find(n => !/S\/\s*\d/.test(n.textContent) && n.textContent.trim().length > 1);
            const name = nameEl?.textContent?.trim();
            if (!name) continue;
            const y = docY(el);
            let cat = 'General';
            for (const h of headers) { if (h.y <= y + 5) cat = h.name; else break; }
            if (!(name in map)) map[name] = cat;
        }
        return map;
    }, cats);
}

function parseNextData(data) {
    const results = [];
    function walk(obj, category = 'General') {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(i => walk(i, category)); return; }
        if ((obj.name || obj.title) && (obj.price !== undefined || obj.basePrice !== undefined)) {
            const priceRaw = obj.price ?? obj.basePrice ?? 0;
            const price = typeof priceRaw === 'number'
                ? (priceRaw > 1000 ? priceRaw / 100 : priceRaw)
                : parseFloat(priceRaw) || 0;
            if (price > 0) {
                results.push({
                    restaurant: 'Rokys',
                    category: obj.category ?? obj.categoryName ?? category,
                    name: obj.name || obj.title,
                    description: obj.description || '',
                    price,
                });
            }
            return;
        }
        const catName = obj.categoryName ?? obj.category ?? obj.name;
        Object.values(obj).forEach(v => walk(v, typeof catName === 'string' && catName ? catName : category));
    }
    walk(data);
    return results;
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

async function extractProductsDOM(page, restaurantName) {
    return page.evaluate((name) => {
        const results = [];
        let currentCategory = 'General';

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
            const el = walker.currentNode;

            if ((el.tagName === 'H1' || el.tagName === 'H2' || el.tagName === 'H3') &&
                !el.closest('article') && !el.closest('[class*="product"]') && !el.closest('[class*="item"]')) {
                const txt = el.textContent?.trim();
                if (txt && txt.length > 1 && txt.length < 80) currentCategory = txt;
            }

            const isCard = el.matches('article, [class*="product-card"], [class*="menu-item"], [class*="food-card"], li[class*="item"]');
            if (!isCard) continue;

            const nameEl = el.querySelector('h3, h4, h5, [class*="name"], [class*="title"]');
            const prodName = nameEl?.textContent?.trim() || '';
            if (!prodName || prodName.length < 2) continue;

            // Strikethrough prices
            const strikeEls = el.querySelectorAll('del, s, [class*="line-through"], [class*="old-price"], [class*="before"]');
            const striked = new Set();
            strikeEls.forEach(se => {
                const m = se.textContent.match(/[\d.,]+/);
                if (m) striked.add(parseFloat(m[0].replace(',', '.')));
            });

            const priceMatches = [...el.textContent.matchAll(/S\/\s*([\d.,]+)/g)];
            const prices = priceMatches.map(m => parseFloat(m[1].replace(',', '.'))).filter(p => !isNaN(p) && !striked.has(p));
            const price = prices[0] || 0;
            if (price === 0) continue;

            const descEl = el.querySelector('p, [class*="desc"]');
            const description = descEl?.textContent?.trim() || '';

            results.push({ restaurant: name, category: currentCategory, name: prodName, description, price });
        }
        return results;
    }, restaurantName);
}

function saveUnique(results, storeId) {
    const seen = new Set();
    const unique = results.filter(p => {
        if (!p.name || seen.has(p.name)) return false;
        seen.add(p.name);
        return true;
    });

    console.log(`\nTotal de productos únicos: ${unique.length}`);
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

const targetUrl = process.argv[2] || 'https://rokys.com/menu';
scrapeRokys(targetUrl);
