const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * Little Caesars Peru scraper — pe.littlecaesars.com/es-pe/menu/
 * React app — extracts products from DOM and __NEXT_DATA__ if available.
 * Always takes the CURRENT price, not promotional crossed-out prices.
 */
async function scrapeLittleCaesars(url = 'https://pe.littlecaesars.com/es-pe/menu/') {
    console.log(`Iniciando scraping de Little Caesars: ${url}`);
    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    let results = [];

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Try __NEXT_DATA__ first
        const nextData = await page.evaluate(() => {
            const script = document.getElementById('__NEXT_DATA__');
            return script ? JSON.parse(script.textContent) : null;
        });

        if (nextData) {
            console.log('Encontrado __NEXT_DATA__, extrayendo...');
            results = parseNextData(nextData);
        }

        // Fallback: DOM extraction
        if (results.length < 3) {
            console.log('Extrayendo desde DOM...');
            await autoScroll(page);
            results = await extractLCProducts(page);
        }

    } catch (err) {
        console.error(`Error: ${err.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    return saveUnique(results, 'littlecaesars-pe');
}

function parseNextData(nextData) {
    const results = [];
    try {
        // Walk through all keys looking for product arrays
        const json = JSON.stringify(nextData);
        const sections = nextData?.props?.pageProps;
        if (!sections) return results;

        // Recurse through the object looking for arrays with name+price
        function walk(obj, category = 'General') {
            if (!obj || typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
                obj.forEach(item => walk(item, category));
                return;
            }
            // Check if this object looks like a product
            if ((obj.name || obj.title) && (obj.price !== undefined || obj.basePrice !== undefined)) {
                const priceRaw = obj.price ?? obj.basePrice ?? obj.unitPrice ?? 0;
                const price = typeof priceRaw === 'number'
                    ? (priceRaw > 1000 ? priceRaw / 100 : priceRaw)  // handle cents
                    : parseFloat(priceRaw) || 0;
                results.push({
                    restaurant: 'Little Caesars',
                    category: obj.category ?? obj.categoryName ?? category,
                    name: obj.name || obj.title,
                    description: obj.description || obj.shortDescription || '',
                    price,
                });
                return;
            }
            // Check if this object looks like a category
            const catName = obj.categoryName ?? obj.category ?? obj.name ?? category;
            Object.values(obj).forEach(v => walk(v, typeof catName === 'string' ? catName : category));
        }
        walk(sections);
    } catch (_) {}
    return results;
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise(resolve => {
            let y = 0;
            const timer = setInterval(() => {
                window.scrollBy(0, 400);
                y += 400;
                if (y >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
            }, 300);
        });
        window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);
}

async function extractLCProducts(page) {
    return page.evaluate(() => {
        const results = [];
        let currentCategory = 'General';

        // LC uses section-based layout
        const sections = document.querySelectorAll('section, [class*="category"], [class*="section"]');
        sections.forEach(section => {
            const header = section.querySelector('h2, h3, h4, [class*="title"]');
            if (header) currentCategory = header.textContent?.trim() || currentCategory;

            const cards = section.querySelectorAll('[class*="product"], [class*="item"], article, li');
            cards.forEach(card => {
                const nameEl = card.querySelector('h3, h4, h5, [class*="name"], [class*="title"]');
                const productName = nameEl?.textContent?.trim() || '';
                if (!productName || productName.length < 2) return;

                // Skip strikethrough prices
                const strikeEls = card.querySelectorAll('del, s, [class*="line-through"], [class*="old-price"], [class*="was"]');
                const strikethroughPrices = new Set();
                strikeEls.forEach(el => {
                    const m = el.textContent.match(/[\d.,]+/);
                    if (m) strikethroughPrices.add(parseFloat(m[0].replace(',', '.')));
                });

                // All price candidates in the card
                const priceEls = card.querySelectorAll('[class*="price"], [class*="cost"], [class*="monto"]');
                let price = 0;
                priceEls.forEach(el => {
                    if (el.closest('del, s')) return; // inside strikethrough
                    const m = el.textContent.match(/[\d.,]+/);
                    if (m) {
                        const v = parseFloat(m[0].replace(',', '.'));
                        if (!strikethroughPrices.has(v) && v > 0 && price === 0) price = v;
                    }
                });

                // Fallback: regex on full text excluding strikethrough
                if (price === 0) {
                    const fullText = card.textContent || '';
                    const matches = [...fullText.matchAll(/S\/\s*([\d.,]+)/g)];
                    const prices = matches
                        .map(m => parseFloat(m[1].replace(',', '.')))
                        .filter(p => !isNaN(p) && !strikethroughPrices.has(p));
                    price = prices.length > 0 ? prices[0] : 0;
                }

                if (price === 0) return;

                const descEl = card.querySelector('[class*="desc"], p');
                const description = descEl?.textContent?.trim() || '';

                results.push({ restaurant: 'Little Caesars', category: currentCategory, name: productName, description, price });
            });
        });

        // Fallback: full DOM scan
        if (results.length === 0) {
            document.querySelectorAll('article, [class*="menu-item"], [class*="product-card"]').forEach(card => {
                const nameEl = card.querySelector('h2, h3, h4, [class*="name"]');
                const name = nameEl?.textContent?.trim() || '';
                if (!name) return;

                const strikeEls = card.querySelectorAll('del, s');
                const striked = new Set();
                strikeEls.forEach(e => {
                    const m = e.textContent.match(/[\d.,]+/);
                    if (m) striked.add(parseFloat(m[0].replace(',', '.')));
                });

                const priceMatches = [...card.textContent.matchAll(/S\/\s*([\d.,]+)/g)];
                const prices = priceMatches.map(m => parseFloat(m[1].replace(',', '.'))).filter(p => !isNaN(p) && !striked.has(p));
                const price = prices[0] || 0;
                if (price === 0) return;

                results.push({ restaurant: 'Little Caesars', category: 'General', name, description: '', price });
            });
        }

        return results;
    });
}

function saveUnique(results, storeId) {
    const seen = new Set();
    const unique = results.filter(p => {
        if (!p.name || seen.has(p.name)) return false;
        seen.add(p.name);
        return true;
    });

    console.log(`\nTotal de productos únicos extraídos: ${unique.length}`);
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

const targetUrl = process.argv[2] || 'https://pe.littlecaesars.com/es-pe/menu/';
scrapeLittleCaesars(targetUrl);
