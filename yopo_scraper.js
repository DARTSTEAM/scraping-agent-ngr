const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * Yopo Peru scraper — yopo.pe/categorias/
 * WordPress + Elementor + WooCommerce (NOT Digifood articles).
 * Category anchors are empty #id divs; products are woo title/price widgets.
 * Category is assigned by vertical position relative to those anchors.
 */
async function scrapeYopo(url = 'https://yopo.pe/categorias/') {
    console.log(`Iniciando scraping de Yopo: ${url}`);
    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    let results = [];

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(3000);
        try { await page.click('button:has-text("Aceptar todo")', { timeout: 4000 }); } catch (_) {}
        try { await page.click('button:has-text("Aceptar")', { timeout: 2000 }); } catch (_) {}
        await page.waitForTimeout(1500);
        await autoScroll(page);

        results = await page.evaluate(() => {
            const docY = el => el.getBoundingClientRect().top + window.scrollY;

            const ANCHOR_LABELS = {
                destacado: 'Destacado de la semana',
                promociones: 'Promociones',
                wrappers: 'Wrappers',
                tendersynuggets: 'Tenders & Nuggets',
                hamburguesas: 'Hamburguesas',
                ensaladas: 'Ensaladas',
                complementos: 'Complementos',
                bowls: 'Bowls',
                postres: 'Postres',
                bebidas: 'Bebidas',
            };

            const headers = [];
            for (const [id, name] of Object.entries(ANCHOR_LABELS)) {
                const el = document.getElementById(id);
                if (el) headers.push({ name, y: docY(el) });
            }
            // Also pick up visible section headings
            for (const el of document.querySelectorAll('h1, h2, h3, .elementor-heading-title')) {
                const t = (el.textContent || '').trim();
                if (!t || t.length > 60) continue;
                const match = Object.values(ANCHOR_LABELS).find(n => n.toLowerCase() === t.toLowerCase());
                if (match) {
                    const y = docY(el);
                    if (!headers.some(h => h.name === match && Math.abs(h.y - y) < 80)) {
                        headers.push({ name: match, y });
                    }
                }
            }
            headers.sort((a, b) => a.y - b.y);

            // Product cards: containers that have both a woo title and a price
            const titleWidgets = [...document.querySelectorAll(
                '.elementor-widget-woocommerce-product-title, .woocommerce-loop-product__title, h2.product_title, .product-title'
            )];

            const results = [];
            const seen = new Set();

            for (const titleWidget of titleWidgets) {
                const nameEl = titleWidget.querySelector('h1, h2, h3, a, .elementor-heading-title') || titleWidget;
                const name = (nameEl.textContent || '').trim();
                if (!name || name.length < 2 || seen.has(name)) continue;

                // Find price nearby: sibling / parent container
                const card = titleWidget.closest('.e-con, .elementor-element[data-element_type="container"], li.product, .product') || titleWidget.parentElement;
                let price = 0;
                const priceRoot = card || titleWidget.parentElement?.parentElement;
                if (priceRoot) {
                    const amount = priceRoot.querySelector('.woocommerce-Price-amount, .price .amount, p.price');
                    if (amount) {
                        const m = amount.textContent.match(/([\d.,]+)/);
                        if (m) price = parseFloat(m[1].replace(',', '.'));
                    }
                }
                if (price === 0) {
                    // Walk forward siblings for a price widget
                    let sib = titleWidget.parentElement;
                    for (let i = 0; i < 6 && sib; i++) {
                        sib = sib.nextElementSibling || sib.parentElement?.nextElementSibling;
                        if (!sib) break;
                        const m = (sib.textContent || '').match(/S\/\s*([\d.,]+)/);
                        if (m) { price = parseFloat(m[1].replace(',', '.')); break; }
                    }
                }
                if (price === 0) continue;

                let description = '';
                if (card) {
                    const descEl = card.querySelector('.woocommerce-product-details__short-description, .elementor-widget-woocommerce-product-short-description, p');
                    if (descEl && !descEl.classList.contains('price')) {
                        description = descEl.textContent?.trim() || '';
                    }
                }

                const y = docY(titleWidget);
                let category = 'General';
                for (const h of headers) {
                    if (h.y <= y + 10) category = h.name;
                    else break;
                }

                results.push({ restaurant: 'Yopo', category, name, description, price });
                seen.add(name);
            }

            // Fallback: any element with woo price + nearby title text
            if (results.length === 0) {
                document.querySelectorAll('p.price, .woocommerce-Price-amount').forEach(priceEl => {
                    const m = priceEl.textContent.match(/([\d.,]+)/);
                    const price = m ? parseFloat(m[1].replace(',', '.')) : 0;
                    if (price === 0) return;
                    const card = priceEl.closest('.e-con, .product, .elementor-element') || priceEl.parentElement;
                    const nameEl = card?.querySelector('h1, h2, h3, a.woocommerce-LoopProduct-link, .product_title');
                    const name = nameEl?.textContent?.trim();
                    if (!name || seen.has(name)) return;
                    const y = docY(priceEl);
                    let category = 'General';
                    for (const h of headers) {
                        if (h.y <= y + 10) category = h.name;
                        else break;
                    }
                    results.push({ restaurant: 'Yopo', category, name, description: '', price });
                    seen.add(name);
                });
            }

            return results;
        });

        console.log(`Extraídos ${results.length} productos`);

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

function saveUnique(results, storeId) {
    const seen = new Set();
    const unique = results.filter(p => {
        const key = `${p.name}||${p.category || ''}`;
        if (!p.name || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`\nTotal de productos únicos extraídos: ${unique.length}`);
    const catCounts = {};
    unique.forEach(p => { catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
    if (unique.length) console.log('Categorías:', Object.entries(catCounts).map(([k, v]) => `${k}(${v})`).join(', '));

    if (unique.length > 0) {
        fs.writeFileSync(path.join(__dirname, `products_${storeId}.json`), JSON.stringify(unique, null, 2));
        const header = 'Restaurant,Category,Product Name,Description,Price';
        const rows = unique.map(p =>
            [esc(p.restaurant), esc(p.category), esc(p.name), esc(p.description), p.price].join(',')
        );
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

const targetUrl = process.argv[2] || 'https://yopo.pe/categorias/';
scrapeYopo(targetUrl);
