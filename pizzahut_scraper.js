const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * Pizza Hut Peru scraper — pizzahut.com.pe/carta/ver-todo
 * Paginates through all pages and extracts product name, description, price.
 * Mirrors the Burger King scraper strategy (article cards, pagination).
 */
async function scrapePizzaHut(url = 'https://www.pizzahut.com.pe/carta/ver-todo') {
    console.log(`Iniciando scraping de Pizza Hut: ${url}`);
    console.log(`🌐 Conectando al navegador remoto en Kernel (proxy residencial Perú)...`);

    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    const results = [];

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

        // Wait for product cards — Pizza Hut uses article tags like BK, or divs with product classes
        const cardSelector = 'article, [class*="product-card"], [class*="ProductCard"], [class*="menu-item"], [class*="MenuItem"]';
        try {
            await page.waitForSelector(cardSelector, { timeout: 20000 });
        } catch (_) {
            console.log('No se encontraron cards estándar, intentando con body...');
        }
        console.log('Página cargada.');

        // Detect total number of pages
        let totalPages = 1;
        try {
            await page.waitForTimeout(2000);
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

            await page.waitForTimeout(1500);

            // Extract using the same tree-walker strategy as BK (category headers + cards)
            const productsWithCategory = await page.evaluate(() => {
                const items = [];
                let currentCategory = 'General';

                const walker = document.createTreeWalker(
                    document.body,
                    NodeFilter.SHOW_ELEMENT
                );

                while (walker.nextNode()) {
                    const el = walker.currentNode;

                    // Section/category headers (h2 or h1 NOT inside a product card)
                    if ((el.tagName === 'H2' || el.tagName === 'H1') && !el.closest('article') && !el.closest('[class*="product"]')) {
                        const text = el.textContent?.trim();
                        if (text && text.length > 1 && text.length < 80) {
                            currentCategory = text;
                        }
                    }

                    // Product cards — article OR div/li with product-related class names
                    const isCard = el.tagName === 'ARTICLE' ||
                        (el.tagName === 'LI' && (el.className.toLowerCase().includes('product') || el.className.toLowerCase().includes('item'))) ||
                        (el.tagName === 'DIV' && (
                            el.className.toLowerCase().includes('productcard') ||
                            el.className.toLowerCase().includes('product-card') ||
                            el.className.toLowerCase().includes('menuitem') ||
                            el.className.toLowerCase().includes('menu-item')
                        ));

                    if (!isCard) continue;

                    // Skip if this card is nested inside another card
                    if (el.parentElement?.closest('article, [class*="productcard"], [class*="menuitem"]')) continue;

                    const nameEl = el.querySelector('h3, h2, h4, [class*="name"], [class*="title"]');
                    const name = nameEl?.textContent?.trim() || '';
                    if (!name) continue;

                    const allPs = Array.from(el.querySelectorAll('p, [class*="description"], [class*="desc"]'));
                    const descEl = allPs.find(p => !p.textContent.includes('S/') && p.textContent.trim().length > 3);
                    const description = descEl?.textContent?.trim() || '';

                    const priceText = el.textContent || '';
                    const priceMatches = [...priceText.matchAll(/S\/\s*([\d.,]+)/g)];
                    let price = 0;
                    if (priceMatches.length > 0) {
                        const prices = priceMatches
                            .map(m => parseFloat(m[1].replace(',', '.')))
                            .filter(p => !isNaN(p) && p > 0);
                        price = prices.length > 1 ? Math.min(...prices) : (prices[0] || 0);
                    }

                    items.push({ name, description, price, category: currentCategory });
                }

                return items;
            });

            const filtered = productsWithCategory.filter(p => p.name.length > 0 && p.price > 0);
            console.log(`  → ${filtered.length} productos encontrados en página ${currentPage}`);
            results.push(...filtered.map(p => ({ ...p, restaurant: 'Pizza Hut' })));

            // Navigate to next page
            if (currentPage < totalPages) {
                const nextClicked = await page.evaluate(() => {
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

                await page.waitForTimeout(3000);
            }
        }

        // If no products found with card selectors, try a broader approach
        if (results.length === 0) {
            console.log('No se encontraron productos con selectores estándar, intentando scraping genérico...');
            const generic = await page.evaluate(() => {
                const items = [];
                // Find any element mentioning S/ price near a product name
                const priceEls = Array.from(document.querySelectorAll('*')).filter(el => {
                    return el.children.length === 0 && /S\/\s*[\d.,]+/.test(el.textContent || '');
                });
                priceEls.forEach(priceEl => {
                    const container = priceEl.closest('li, article, div[class], tr') || priceEl.parentElement;
                    if (!container) return;
                    const nameEl = container.querySelector('h2, h3, h4, h5, strong');
                    const name = nameEl?.textContent?.trim() || '';
                    if (!name) return;
                    const priceMatch = (priceEl.textContent || '').match(/S\/\s*([\d.,]+)/);
                    const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : 0;
                    if (price > 0) items.push({ name, description: '', price, category: 'General' });
                });
                return items;
            });
            results.push(...generic.map(p => ({ ...p, restaurant: 'Pizza Hut' })));
            console.log(`  → ${generic.length} productos via scraping genérico`);
        }

    } catch (error) {
        console.error(`Error durante el scraping: ${error.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
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

const targetUrl = process.argv[2] || 'https://www.pizzahut.com.pe/carta/ver-todo';
scrapePizzaHut(targetUrl);
