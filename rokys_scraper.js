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

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Try embedded JSON data sources
        const embedded = await page.evaluate(() => {
            const nextScript = document.getElementById('__NEXT_DATA__');
            if (nextScript) {
                try { return { type: 'next', data: JSON.parse(nextScript.textContent) }; } catch (_) {}
            }
            const nuxt = document.getElementById('__NUXT_DATA__') || document.querySelector('[id="__NUXT_DATA__"]');
            if (nuxt) {
                try { return { type: 'nuxt', data: JSON.parse(nuxt.textContent) }; } catch (_) {}
            }
            return null;
        });

        if (embedded?.type === 'next') {
            console.log('Encontrado __NEXT_DATA__, extrayendo...');
            results = parseNextData(embedded.data);
        }

        // DOM fallback with scroll
        if (results.length < 3) {
            await autoScroll(page);
            results = await extractProductsDOM(page, 'Rokys');
        }

        // Paginate if needed
        if (results.length > 0) {
            let pageNum = 1;
            while (true) {
                const clicked = await clickNext(page);
                if (!clicked) break;
                pageNum++;
                console.log(`Página ${pageNum}...`);
                await page.waitForTimeout(3000);
                await autoScroll(page);
                const more = await extractProductsDOM(page, 'Rokys');
                results.push(...more);
            }
        }

    } catch (err) {
        console.error(`Error: ${err.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    return saveUnique(results, 'rokys-pe');
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
