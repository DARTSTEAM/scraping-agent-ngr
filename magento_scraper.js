const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const { stamp } = require('./scrape_meta');
const fs = require('fs');
const path = require('path');

/**
 * Generic Magento scraper for NGR own-brand sites.
 * All 6 brands (Bembos, Popeyes, Papa Johns, Dunkin, Don Belisario, Chinawok)
 * share the same Magento/SummaTheme frontend with identical DOM structure.
 *
 * Categories:
 *   - Parent sections are /menu/<slug> (Combos, Hamburguesas, Promociones, …)
 *   - Subcategory filters (Personales, Para 2, …) are ignored when a parent exists
 *   - Prefer the general/parent category; never emit "General"
 */

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

/** Extract products from the current page; parentCategory is the section fallback. */
function extractMagentoProductsBrowser({ restaurantName, parentCategory }) {
    const results = [];
    const seen = new Set();

    const catMap = {};
    document.querySelectorAll('[data-role="grouped-subcategory-filter"]').forEach(a => {
        const id = a.getAttribute('data-id');
        const title = a.getAttribute('title') || a.textContent?.trim();
        if (id && title && title.toLowerCase() !== 'todos') catMap[id] = title;
    });

    // Parent title from section H2 inside each grouped block (overrides arg when walking)
    const sectionParentByItem = new WeakMap();
    document.querySelectorAll('[data-role="grouped-category-section"], .products-category-grouped').forEach(section => {
        const h2 = section.querySelector('.category-grouped-title h2, h2');
        const parent = h2?.textContent?.trim();
        if (!parent) return;
        section.querySelectorAll('li.product-item').forEach(item => {
            sectionParentByItem.set(item, parent);
        });
    });

    // Also map via document-order: .category-grouped-title h2 then following products
    let walkParent = parentCategory || null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
        const el = walker.currentNode;

        if (el.classList && el.classList.contains('category-grouped-title')) {
            const h2 = el.querySelector('h2') || (el.tagName === 'H2' ? el : null);
            const text = (h2 || el).textContent?.trim();
            if (text && text.length > 1 && text.length < 80 && !/preguntas frecuentes/i.test(text)) {
                walkParent = text;
            }
        }

        if (el.tagName !== 'LI' || !el.classList || !el.classList.contains('product-item')) continue;

        const nameEl = el.querySelector('.product-item-name a, .product-item-link');
        const name = nameEl?.textContent?.trim();
        if (!name) continue;

        const descEl = el.querySelector('.product-item-description p, .product-item-description');
        const description = descEl?.textContent?.trim() || '';

        const finalPriceEl = el.querySelector('[data-price-type="finalPrice"]');
        const oldPriceEl = el.querySelector('[data-price-type="oldPrice"]');
        let price = 0;
        if (finalPriceEl) {
            price = parseFloat(finalPriceEl.getAttribute('data-price-amount')) || 0;
        } else if (oldPriceEl) {
            price = parseFloat(oldPriceEl.getAttribute('data-price-amount')) || 0;
        } else {
            const priceText = el.querySelector('.price')?.textContent || '';
            const match = priceText.match(/S\/\s*([\d.,]+)/);
            if (match) price = parseFloat(match[1].replace(',', '.'));
        }
        if (price === 0) continue;

        const className = el.className || '';
        const catIds = [...className.matchAll(/cat-(\d+)/g)].map(m => m[1]);
        let subcategory = null;
        for (const id of catIds) {
            if (catMap[id]) { subcategory = catMap[id]; break; }
        }

        const parentFromPath = (() => {
            try {
                const m = location.pathname.match(/^\/menu\/([a-z0-9-]+)\/?$/i);
                if (!m) return null;
                const slug = m[1].toLowerCase();
                if (slug === 'ver-todo' || slug === 'menu') return null;
                return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            } catch (_) {
                return null;
            }
        })();
        const parent = parentCategory || sectionParentByItem.get(el) || walkParent || parentFromPath || null;
        const category = parent || subcategory || null;
        if (!category) continue;

        const key = `${name}||${category}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const sku = el.querySelector('[data-product-sku]')?.getAttribute('data-product-sku') || '';
        results.push({ restaurant: restaurantName, category, name, description, price, sku });
    }

    return results;
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
    const origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();

    try {
        console.log('Navegando a la página de menú...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('.product-item, [data-role="grouped-category-anchor"]', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
        await autoScroll(page);

        // Discover parent category routes: /menu/<slug>
        const parentCategories = await page.evaluate(() => {
            const seen = new Map();
            const anchors = document.querySelectorAll(
                '[data-role="grouped-category-anchor"], a[href*="/menu/"]'
            );
            for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                let path = href;
                try { path = new URL(href, location.origin).pathname; } catch (_) {}
                const m = path.match(/^\/menu\/([a-z0-9-]+)\/?$/i);
                if (!m) continue;
                const slug = m[1].toLowerCase();
                if (slug === 'ver-todo') continue;
                let name = (a.getAttribute('title') || a.textContent || '').trim();
                // Clean "Combos Ver todo" / doubled labels
                name = name.replace(/\s*Ver todo\s*/gi, '').trim();
                const half = name.slice(0, name.length / 2);
                if (name.length % 2 === 0 && half === name.slice(name.length / 2)) name = half;
                if (!name) {
                    name = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                }
                if (!seen.has(slug) && name.length < 80) {
                    seen.set(slug, { href: path, slug, name });
                }
            }
            // Also from section H2 titles paired with nearby "Ver todo" links
            document.querySelectorAll('.category-grouped-title h2').forEach(h2 => {
                const name = h2.textContent?.trim();
                if (!name || /preguntas frecuentes/i.test(name)) return;
                const section = h2.closest('[data-role="grouped-category-section"], .products-category-grouped, section, div');
                const link = section?.querySelector('a[href*="/menu/"]');
                if (!link) return;
                let path = link.getAttribute('href') || '';
                try { path = new URL(path, location.origin).pathname; } catch (_) {}
                const m = path.match(/^\/menu\/([a-z0-9-]+)\/?$/i);
                if (!m) return;
                const slug = m[1].toLowerCase();
                if (!seen.has(slug)) seen.set(slug, { href: path, slug, name });
            });
            return [...seen.values()];
        });

        console.log(`Categorías padre: ${parentCategories.length} → ${parentCategories.map(c => c.name).join(', ')}`);

        if (parentCategories.length > 0 && origin) {
            for (const cat of parentCategories) {
                const catUrl = `${origin}${cat.href}`;
                console.log(`Scrapeando: ${cat.name} (${catUrl})`);
                try {
                    await page.goto(catUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
                    await page.waitForSelector('.product-item', { timeout: 15000 }).catch(() => {});
                    await page.waitForTimeout(1200);
                    await autoScroll(page);
                    const products = await page.evaluate(extractMagentoProductsBrowser, {
                        restaurantName: brand.name,
                        parentCategory: cat.name,
                    });
                    console.log(`  → ${cat.name}: ${products.length} productos`);
                    allProducts.push(...products);
                } catch (err) {
                    console.warn(`  ⚠ ${cat.name}: ${err.message}`);
                }
            }
        }

        // Coverage pass on the full /menu page
        console.log('Cobertura: página /menu completa...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('.product-item', { timeout: 20000 }).catch(() => {});
        await autoScroll(page);
        const mainProducts = await page.evaluate(extractMagentoProductsBrowser, {
            restaurantName: brand.name,
            parentCategory: null,
        });
        console.log(`  → menú completo: ${mainProducts.length} productos`);
        // Prefer already-tagged products from per-category passes; add only new names
        const seenNames = new Set(allProducts.map(p => p.name));
        for (const p of mainProducts) {
            if (!seenNames.has(p.name)) {
                allProducts.push(p);
                seenNames.add(p.name);
            }
        }

        // Magento pagination on main menu (rare)
        const hasPages = await page.$$eval(
            '.pages-items .item a, .toolbar-products .pages a',
            links => links.map(a => a.getAttribute('href')).filter(Boolean)
        ).catch(() => []);
        const currentUrl = page.url();
        const pageUrls = [...new Set(hasPages)].filter(u => u !== currentUrl && u.includes('p='));
        for (const pageUrl of pageUrls) {
            console.log(`Navegando a página: ${pageUrl}`);
            try {
                await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForSelector('.product-item', { timeout: 15000 }).catch(() => {});
                await autoScroll(page);
                const pageProducts = await page.evaluate(extractMagentoProductsBrowser, {
                    restaurantName: brand.name,
                    parentCategory: null,
                });
                for (const p of pageProducts) {
                    if (!seenNames.has(p.name)) {
                        allProducts.push(p);
                        seenNames.add(p.name);
                    }
                }
            } catch (err) {
                console.warn(`Error en página ${pageUrl}: ${err.message}`);
            }
        }

    } catch (err) {
        console.error(`Error: ${err.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    const seen = new Set();
    const unique = allProducts.filter(p => {
        if (!p.category || p.category === 'General') return false;
        const key = `${p.name}||${p.category}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`\nTotal de productos únicos (${brand.name}): ${unique.length}`);
    const catCounts = {};
    unique.forEach(p => { catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
    console.log('Categorías:', Object.entries(catCounts).map(([k, v]) => `${k}(${v})`).join(', '));

    if (unique.length > 0) {
        const jsonPath = path.join(__dirname, `products_${brand.storeId}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(unique, null, 2));
        const header = 'Restaurant,Category,Product Name,Description,Price';
        const rows = unique.map(p =>
            [esc(p.restaurant), esc(p.category), esc(p.name), esc(p.description), p.price].join(',')
        );
        fs.writeFileSync(path.join(__dirname, `products_${brand.storeId}.csv`), [header, ...rows].join('\n'));
        stamp(brand.storeId);
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

const targetUrl = process.argv[2];
if (!targetUrl) {
    console.error('Usage: node magento_scraper.js <url>');
    process.exit(1);
}

scrapeMagento(targetUrl);
