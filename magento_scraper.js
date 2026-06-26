const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * Generic Magento scraper for NGR own-brand sites.
 * All 6 brands (Bembos, Popeyes, Papa Johns, Dunkin, Don Belisario, Chinawok)
 * share the same Magento/SummaTheme frontend with identical DOM structure.
 *
 * Products are server-rendered in <li class="product-item"> elements.
 * Categories use a grouped layout with <h2> headers and subcategory filters.
 * Prices use data-price-amount attributes (finalPrice vs oldPrice).
 */

// Brand dispatch map
const BRAND_MAP = {
    'bembos.com.pe':       { name: 'Bembos',        storeId: 'bembos-pe' },
    'popeyes.com.pe':      { name: 'Popeyes',       storeId: 'popeyes-pe' },
    'papajohns.com.pe':    { name: 'Papa Johns',    storeId: 'papajohns-pe' },
    'dunkin.pe':           { name: "Dunkin'",        storeId: 'dunkin-pe' },
    'donbelisario.com.pe': { name: 'Don Belisario', storeId: 'donbelisario-pe' },
    'chinawok.com.pe':     { name: 'Chinawok',      storeId: 'chinawok-pe' },
};

function detectBrand(url) {
    for (const [domain, info] of Object.entries(BRAND_MAP)) {
        if (url.includes(domain)) return info;
    }
    return { name: 'Restaurant', storeId: 'ngr-generic' };
}

async function scrapeMagento(url) {
    const brand = detectBrand(url);
    console.log(`Iniciando scraping de ${brand.name}: ${url}`);

    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    const allProducts = [];

    try {
        // Navigate to menu page
        console.log('Navegando a la página de menú...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('.product-item', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);

        // Scroll to load lazy images and deferred content
        await autoScroll(page);

        // Extract all products from the page
        const products = await page.evaluate((restaurantName) => {
            const results = [];
            const seen = new Set();

            // Try to build a category map from grouped subcategory filters
            // Format: <a data-id="607" title="Promociones para 2">
            const catMap = {};
            document.querySelectorAll('[data-role="grouped-subcategory-filter"]').forEach(a => {
                const id = a.getAttribute('data-id');
                const title = a.getAttribute('title') || a.textContent?.trim();
                if (id && title) catMap[id] = title;
            });

            // Also check H2 section headers for category context
            // Magento grouped layout: <h2><span>Category Name</span></h2> followed by product grid
            const sectionHeaders = {};
            document.querySelectorAll('.category-title h2, .grouped-category h2, .category-header h2').forEach(h2 => {
                const text = h2.textContent?.trim();
                if (text) {
                    // Try to find the next product list
                    const section = h2.closest('.category-section, .grouped-category, [class*="category"]');
                    if (section) {
                        section.querySelectorAll('.product-item').forEach(item => {
                            const itemId = item.querySelector('[data-product-id]')?.getAttribute('data-product-id');
                            if (itemId) sectionHeaders[itemId] = text;
                        });
                    }
                }
            });

            // Extract products
            document.querySelectorAll('li.product-item').forEach(item => {
                // Product name
                const nameEl = item.querySelector('.product-item-name a, .product-item-link');
                const name = nameEl?.textContent?.trim();
                if (!name || seen.has(name)) return;
                seen.add(name);

                // Description
                const descEl = item.querySelector('.product-item-description p, .product-item-description');
                const description = descEl?.textContent?.trim() || '';

                // Price — use data-price-amount for accuracy, prefer finalPrice over oldPrice
                const finalPriceEl = item.querySelector('[data-price-type="finalPrice"]');
                const oldPriceEl = item.querySelector('[data-price-type="oldPrice"]');
                let price = 0;

                if (finalPriceEl) {
                    price = parseFloat(finalPriceEl.getAttribute('data-price-amount')) || 0;
                } else if (oldPriceEl) {
                    price = parseFloat(oldPriceEl.getAttribute('data-price-amount')) || 0;
                } else {
                    // Fallback: extract from text S/XX.XX
                    const priceText = item.querySelector('.price')?.textContent || '';
                    const match = priceText.match(/S\/\s*([\d.,]+)/);
                    if (match) price = parseFloat(match[1].replace(',', '.'));
                }

                if (price === 0) return;

                // Category — try multiple sources
                const productId = item.querySelector('[data-product-id]')?.getAttribute('data-product-id');
                const catClass = item.className.match(/cat-(\d+)/);
                const catId = catClass?.[1];
                let category = catMap[catId] || sectionHeaders[productId] || 'General';

                // SKU
                const sku = item.querySelector('[data-product-sku]')?.getAttribute('data-product-sku') || '';

                results.push({
                    restaurant: restaurantName,
                    category,
                    name,
                    description,
                    price,
                    sku,
                });
            });

            return results;
        }, brand.name);

        allProducts.push(...products);
        console.log(`Extraídos ${products.length} productos de la página principal.`);

        // Check if there are more pages (Magento pagination)
        const hasPages = await page.$$eval(
            '.pages-items .item a, .toolbar-products .pages a',
            links => links.map(a => a.getAttribute('href')).filter(Boolean)
        ).catch(() => []);

        // Get unique page URLs (skip current page)
        const currentUrl = page.url();
        const pageUrls = [...new Set(hasPages)].filter(u => u !== currentUrl && u.includes('p='));

        for (const pageUrl of pageUrls) {
            console.log(`Navegando a página: ${pageUrl}`);
            try {
                await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForSelector('.product-item', { timeout: 15000 }).catch(() => {});
                await autoScroll(page);

                const pageProducts = await page.evaluate((restaurantName) => {
                    const results = [];
                    document.querySelectorAll('li.product-item').forEach(item => {
                        const nameEl = item.querySelector('.product-item-name a, .product-item-link');
                        const name = nameEl?.textContent?.trim();
                        if (!name) return;

                        const descEl = item.querySelector('.product-item-description p, .product-item-description');
                        const description = descEl?.textContent?.trim() || '';

                        const finalPriceEl = item.querySelector('[data-price-type="finalPrice"]');
                        let price = 0;
                        if (finalPriceEl) {
                            price = parseFloat(finalPriceEl.getAttribute('data-price-amount')) || 0;
                        } else {
                            const priceText = item.querySelector('.price')?.textContent || '';
                            const match = priceText.match(/S\/\s*([\d.,]+)/);
                            if (match) price = parseFloat(match[1].replace(',', '.'));
                        }
                        if (price === 0) return;

                        const catClass = item.className.match(/cat-(\d+)/);
                        const category = catClass?.[1] || 'General';

                        results.push({ restaurant: restaurantName, category, name, description, price });
                    });
                    return results;
                }, brand.name);

                console.log(`  → ${pageProducts.length} productos en página adicional`);
                allProducts.push(...pageProducts);
            } catch (err) {
                console.warn(`Error en página ${pageUrl}: ${err.message}`);
            }
        }

    } catch (err) {
        console.error(`Error: ${err.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    // Deduplicate by name
    const seen = new Set();
    const unique = allProducts.filter(p => {
        if (seen.has(p.name)) return false;
        seen.add(p.name);
        return true;
    });

    console.log(`\nTotal de productos únicos (${brand.name}): ${unique.length}`);

    if (unique.length > 0) {
        const jsonPath = path.join(__dirname, `products_${brand.storeId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(unique, null, 2));

        const header = 'Restaurant,Category,Product Name,Description,Price';
        const rows = unique.map(p =>
            [esc(p.restaurant), esc(p.category), esc(p.name), esc(p.description), p.price].join(',')
        );
        fs.writeFileSync(
            path.join(__dirname, `products_${brand.storeId}.csv`),
            [header, ...rows].join('\n')
        );
        console.log(`Guardado: products_${brand.storeId}.json / .csv`);
    } else {
        console.error('No se extrajo ningún producto.');
        process.exit(1);
    }

    return unique;
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise(resolve => {
            let y = 0;
            const t = setInterval(() => {
                window.scrollBy(0, 400);
                y += 400;
                if (y >= document.body.scrollHeight) { clearInterval(t); resolve(); }
            }, 200);
        });
        window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);
}

function esc(str) {
    if (!str) return '""';
    return `"${String(str).replace(/"/g, '""')}"`;
}

// Entry point
const targetUrl = process.argv[2];
if (!targetUrl) {
    console.error('Usage: node magento_scraper.js <url>');
    process.exit(1);
}

scrapeMagento(targetUrl);
