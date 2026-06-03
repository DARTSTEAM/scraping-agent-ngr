const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * Yopo Peru scraper — yopo.pe/categorias/
 * Uses the same Digifood platform as Burger King / Wanta.
 * Always takes the CURRENT price, not promotional crossed-out prices.
 */
async function scrapeYopo(url = 'https://yopo.pe/categorias/') {
    console.log(`Iniciando scraping de Yopo: ${url}`);
    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    const results = [];

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);

        // Scroll to trigger lazy loading
        await autoScroll(page);

        const products = await extractDigifoodProducts(page, 'Yopo');
        results.push(...products);

        // If paginated, navigate through pages
        let pageNum = 1;
        while (true) {
            const nextClicked = await clickNext(page);
            if (!nextClicked) break;
            pageNum++;
            console.log(`Procesando página ${pageNum}...`);
            await page.waitForTimeout(3000);
            await autoScroll(page);
            const moreProducts = await extractDigifoodProducts(page, 'Yopo');
            results.push(...moreProducts);
        }

    } catch (err) {
        console.error(`Error: ${err.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    return saveUnique(results, 'yopo-pe');
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise(resolve => {
            let y = 0;
            const timer = setInterval(() => {
                window.scrollBy(0, 400);
                y += 400;
                if (y >= document.body.scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 300);
        });
        window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);
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

async function extractDigifoodProducts(page, restaurantName) {
    return page.evaluate((name) => {
        const results = [];
        let currentCategory = 'General';

        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
            const el = walker.currentNode;

            // Track section headers
            if ((el.tagName === 'H1' || el.tagName === 'H2') && !el.closest('article')) {
                const txt = el.textContent?.trim();
                if (txt && txt.length > 1 && txt.length < 80) currentCategory = txt;
            }

            if (el.tagName === 'ARTICLE') {
                const nameEl = el.querySelector('h3, h2, h4');
                const productName = nameEl?.textContent?.trim() || '';
                if (!productName) continue;

                // Description: first <p> without price
                const allPs = Array.from(el.querySelectorAll('p'));
                const descEl = allPs.find(p => !p.textContent.includes('S/'));
                const description = descEl?.textContent?.trim() || '';

                // Price: prefer the NON-strikethrough price
                // Crossed-out prices are in <del>, <s>, or have class 'line-through'/'old-price'
                const strikeEls = el.querySelectorAll('del, s, [class*="line-through"], [class*="old-price"], [class*="original-price"], [class*="tachado"]');
                const strikethroughPrices = new Set();
                strikeEls.forEach(el => {
                    const m = el.textContent.match(/[\d.,]+/);
                    if (m) strikethroughPrices.add(parseFloat(m[0].replace(',', '.')));
                });

                const allPriceMatches = [...el.textContent.matchAll(/S\/\s*([\d.,]+)/g)];
                const prices = allPriceMatches
                    .map(m => parseFloat(m[1].replace(',', '.')))
                    .filter(p => !isNaN(p) && !strikethroughPrices.has(p));

                const price = prices.length > 0 ? prices[0] : 0;
                if (price === 0) continue;

                results.push({ restaurant: name, category: currentCategory, name: productName, description, price });
            }
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

    console.log(`\nTotal de productos únicos extraídos: ${unique.length}`);

    if (unique.length > 0) {
        const jsonPath = path.join(__dirname, `products_${storeId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(unique, null, 2));
        console.log(`JSON guardado en: ${jsonPath}`);

        const header = 'Restaurant,Category,Product Name,Description,Price';
        const rows = unique.map(p =>
            [esc(p.restaurant), esc(p.category), esc(p.name), esc(p.description), p.price].join(',')
        );
        const csvPath = path.join(__dirname, `products_${storeId}.csv`);
        fs.writeFileSync(csvPath, [header, ...rows].join('\n'));
        console.log(`CSV guardado en: ${csvPath}`);
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

const targetUrl = process.argv[2] || 'https://yopo.pe/categorias/';
scrapeYopo(targetUrl);
