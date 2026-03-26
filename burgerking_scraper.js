const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/**
 * Burger King Peru scraper — burgerking.pe/carta/ver-todo
 * Paginates through all pages and extracts product name, description, price.
 */
async function scrapeBurgerKing(url = 'https://www.burgerking.pe/carta/ver-todo') {
    console.log(`Iniciando scraping de Burger King: ${url}`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'es-PE',
        viewport: { width: 1280, height: 900 }
    });

    const page = await context.newPage();
    const results = [];

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        // BK site has persistent background requests — wait for product cards instead
        await page.waitForSelector('article', { timeout: 20000 });
        console.log('Página cargada.');

        // Detect total number of pages
        let totalPages = 1;
        try {
            // Wait a moment for pagination to render
            await page.waitForTimeout(1000);
            // Look for a "last page" button or the highest visible number button
            const pageNums = await page.$$eval(
                'nav button, [class*="pagination"] button, [class*="pager"] button',
                (btns) => btns
                    .map(b => parseInt(b.textContent?.trim()))
                    .filter(n => !isNaN(n) && n > 0)
            );
            if (pageNums.length > 0) totalPages = Math.max(...pageNums);
        } catch (_) {}

        // Fallback: look for numbered pagination text
        if (totalPages === 1) {
            try {
                const allText = await page.textContent('body');
                const match = allText.match(/página\s+\d+\s+de\s+(\d+)/i) ||
                              allText.match(/(\d+)\s+páginas/i);
                if (match) totalPages = parseInt(match[1]);
            } catch (_) {}
        }

        console.log(`Total de páginas detectadas: ${totalPages}`);

        for (let currentPage = 1; currentPage <= totalPages; currentPage++) {
            console.log(`Procesando página ${currentPage} de ${totalPages}...`);

            // Wait for product cards to appear
            try {
                await page.waitForSelector('article', { timeout: 15000 });
            } catch (_) {
                console.warn(`No se encontraron artículos en página ${currentPage}, continuando...`);
                break;
            }

            // Extract all products on this page
            const products = await page.evaluate(() => {
                const cards = Array.from(document.querySelectorAll('article'));
                return cards.map(card => {
                    // Name — first h3 or h2 in the card
                    const nameEl = card.querySelector('h3, h2, h4');
                    const name = nameEl?.textContent?.trim() || '';

                    // Description — first <p> that doesn't contain 'S/'
                    const allPs = Array.from(card.querySelectorAll('p'));
                    const descEl = allPs.find(p => !p.textContent.includes('S/'));
                    const description = descEl?.textContent?.trim() || '';

                    // Price — look for "S/" in text nodes
                    const priceText = card.textContent || '';
                    // Find all prices (some have original + discounted)
                    const priceMatches = [...priceText.matchAll(/S\/\s*([\d.,]+)/g)];
                    let price = 0;
                    if (priceMatches.length > 0) {
                        // Last match is normally the current price
                        // If multiple prices, the lowest one is the discounted price
                        const prices = priceMatches
                            .map(m => parseFloat(m[1].replace(',', '.')))
                            .filter(p => !isNaN(p));
                        price = prices.length > 1 ? Math.min(...prices) : prices[0] || 0;
                    }

                    // Category: try to detect from the page section header above the card
                    // (BK groups by category with sticky headers)
                    return { name, description, price };
                }).filter(p => p.name.length > 0);
            });

            // Tag category from visible section headers on the page
            const productsWithCategory = await page.evaluate(() => {
                const results = [];
                // Walk all elements in order, track last h2/h3 section header
                let currentCategory = 'Ver Todo';
                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_ELEMENT
                );

                while (walker.nextNode()) {
                    const el = walker.currentNode;
                    // Section headers are typically h2 tags NOT inside article
                    if ((el.tagName === 'H2' || el.tagName === 'H1') && !el.closest('article')) {
                        const text = el.textContent?.trim();
                        if (text && text.length > 1 && text.length < 60) {
                            currentCategory = text;
                        }
                    }
                    if (el.tagName === 'ARTICLE') {
                        const nameEl = el.querySelector('h3, h2, h4');
                        const name = nameEl?.textContent?.trim() || '';
                        if (!name) continue;

                        const allPs = Array.from(el.querySelectorAll('p'));
                        const descEl = allPs.find(p => !p.textContent.includes('S/'));
                        const description = descEl?.textContent?.trim() || '';

                        const priceText = el.textContent || '';
                        const priceMatches = [...priceText.matchAll(/S\/\s*([\d.,]+)/g)];
                        let price = 0;
                        if (priceMatches.length > 0) {
                            const prices = priceMatches
                                .map(m => parseFloat(m[1].replace(',', '.')))
                                .filter(p => !isNaN(p));
                            price = prices.length > 1 ? Math.min(...prices) : (prices[0] || 0);
                        }

                        results.push({ name, description, price, category: currentCategory });
                    }
                }
                return results;
            });

            const filtered = productsWithCategory.filter(p => p.name.length > 0 && p.price > 0);
            console.log(`  → ${filtered.length} productos encontrados en página ${currentPage}`);
            results.push(...filtered.map(p => ({ ...p, restaurant: 'Burger King' })));

            // Go to next page using the next (→) arrow button
            if (currentPage < totalPages) {
                const nextClicked = await page.evaluate(() => {
                    // Find the next-arrow button — usually contains '>' or '›' or aria-label next
                    const buttons = Array.from(document.querySelectorAll('button, a'));
                    const nextBtn = buttons.find(b => {
                        const text = b.textContent?.trim();
                        const label = b.getAttribute('aria-label') || '';
                        return (
                            text === '>' || text === '›' || text === '→' || text === '»' ||
                            label.toLowerCase().includes('siguiente') ||
                            label.toLowerCase().includes('next')
                        );
                    });
                    if (nextBtn && !nextBtn.hasAttribute('disabled')) {
                        nextBtn.click();
                        return true;
                    }
                    return false;
                });

                if (!nextClicked) {
                    console.warn(`No se encontró botón siguiente en página ${currentPage}. Deteniendo.`);
                    break;
                }

                // Wait for new products to render
                await page.waitForTimeout(3000);
            }
        }

    } catch (error) {
        console.error(`Error durante el scraping: ${error.message}`);
    } finally {
        await browser.close();
    }

    // Deduplicate by name
    const seen = new Set();
    const unique = results.filter(p => {
        if (seen.has(p.name)) return false;
        seen.add(p.name);
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

const targetUrl = process.argv[2] || 'https://www.burgerking.pe/carta/ver-todo';
scrapeBurgerKing(targetUrl);
