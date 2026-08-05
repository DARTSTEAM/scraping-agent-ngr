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
        await page.waitForTimeout(2000);
        await dismissModals(page);
        await handleStoreModal(page);
        await page.waitForSelector('article, .product-card, a[href*="/pedir/"], h3.categoryTitle', { timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(1500);

        // Discover /carta/<slug> or /pedir/<slug> category routes
        const categories = await page.evaluate(() => {
            const seen = new Map();
            for (const a of document.querySelectorAll('a[href]')) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/^\/(carta|pedir|categorias)\/([a-z0-9-]+)\/?$/i);
                if (!m) continue;
                const slug = m[2].toLowerCase();
                if (slug === 'ver-todo' || slug === 'todas') continue;
                let text = (a.textContent || '').trim();
                const half = text.slice(0, text.length / 2);
                if (text.length % 2 === 0 && half === text.slice(text.length / 2)) text = half;
                if (!seen.has(href) && text && text.length < 80) seen.set(href, { href, name: text, section: m[1].toLowerCase() });
            }
            return [...seen.values()];
        });

        if (categories.length > 0 && origin) {
            console.log(`Categorías detectadas: ${categories.length} → ${categories.map(c => c.name).join(', ')}`);
            const nameToCategory = new Map();
            const perCatProducts = [];
            for (const cat of categories) {
                const catUrl = cat.href.startsWith('http') ? cat.href : `${origin}${cat.href}`;
                const catProducts = await scrapeCategoryPage(page, catUrl, cat.name, restaurantName);
                console.log(`  → ${cat.name}: ${catProducts.length} productos`);
                for (const p of catProducts) {
                    if (!nameToCategory.has(p.name)) nameToCategory.set(p.name, cat.name);
                    perCatProducts.push(p);
                }
            }
            // Coverage pass for Carta-style menus
            if (categories.some(c => c.section === 'carta')) {
                const all = await scrapeCategoryPage(page, `${origin}/carta/ver-todo`, 'Otros', restaurantName);
                results = all.map(p => ({ ...p, category: nameToCategory.get(p.name) || 'Otros' }));
                console.log(`Cobertura ver-todo: ${all.length} · con categoría mapeada: ${all.filter(p => nameToCategory.has(p.name)).length}`);
            } else {
                // /pedir (or categorias) routes already cover the menu
                results = perCatProducts;
            }
        } else {
            // /pedir Justo sites (Chifa Express, Cinnabon): single long page with
            // h3.categoryTitle sections and .product-card links — no Digifood articles.
            console.log('Flujo /pedir (Justo / product-card)...');
            await autoScroll(page);
            await page.waitForTimeout(1500);
            results = await extractProducts(page, restaurantName);
            console.log(`  → ${results.length} productos en página única`);

            // If still empty, try Digifood article pagination as last resort
            if (results.length === 0) {
                console.log('Sin product-cards; intentando paginación Digifood...');
                for (let p = 1; p <= 40; p++) {
                    await page.waitForSelector('article', { timeout: 10000 }).catch(() => {});
                    await autoScroll(page);
                    const pageProducts = await extractProducts(page, restaurantName);
                    console.log(`  → página ${p}: ${pageProducts.length}`);
                    results.push(...pageProducts);
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

async function dismissModals(page) {
    for (const sel of [
        '[data-testid="modal-close"]', 'button[aria-label="Close"]', 'button[aria-label="Cerrar"]',
        '.modal-close', '[class*="dismiss"]', 'button:has-text("Aceptar")', 'button:has-text("Entendido")',
        'button:has-text("Cerrar")',
    ]) {
        try {
            const btn = await page.$(sel);
            if (btn) { await btn.click(); await page.waitForTimeout(400); }
        } catch (_) {}
    }
}

async function handleStoreModal(page) {
    try {
        await page.waitForTimeout(1000);
        for (const sel of [
            'text=Para llevar', 'text=Recoger', 'text=Delivery', 'text=Pedir ahora',
            'text=Continuar', 'text=Ordenar', '[data-testid*="takeaway"]', '[data-testid*="pickup"]',
        ]) {
            try {
                const btn = await page.$(sel);
                if (btn) { await btn.click(); await page.waitForTimeout(1000); break; }
            } catch (_) {}
        }
        for (const sel of [
            '.store-item:first-child', '[class*="store"]:first-child button',
            '[class*="location"]:first-child', '[class*="tienda"]:first-child',
            'button:has-text("Seleccionar")',
        ]) {
            try {
                const item = await page.$(sel);
                if (item) { await item.click(); await page.waitForTimeout(2000); break; }
            } catch (_) {}
        }
    } catch (_) {}
}

// Navigate to a category route, load all cards, and return its products.
async function scrapeCategoryPage(page, categoryUrl, categoryName, restaurantName) {
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissModals(page);
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
        const seen = new Set();
        let currentCategory = 'General';

        function parsePrice(el) {
            const strikeEls = el.querySelectorAll('del, s, [class*="line-through"], [class*="old-price"], [class*="original"], [class*="tachado"], [class*="before"]');
            const striked = new Set();
            strikeEls.forEach(se => {
                const m = se.textContent.match(/([\d.,]+)/);
                if (m) striked.add(parseFloat(m[0].replace(',', '.')));
            });
            const priceMatches = [...(el.textContent || '').matchAll(/S\/?\s*([\d.,]+)/g)];
            const valid = priceMatches
                .map(m => parseFloat(m[1].replace(',', '.')))
                .filter(p => !isNaN(p) && p > 0 && !striked.has(p));
            if (valid.length === 0) return 0;
            // Promo cards often show regular + promo → take lowest current price
            return Math.min(...valid);
        }

        // Path A: Justo /pedir product-cards (Chifa Express, Cinnabon)
        const justoCards = document.querySelectorAll(
            '.product-card a[href*="/pedir/"], a[href*="/pedir/"][class*="card"], a.rounded-lg[href*="/pedir/"]'
        );
        if (justoCards.length > 0) {
            const docY = el => el.getBoundingClientRect().top + window.scrollY;
            const headers = [...document.querySelectorAll('h3.categoryTitle, h3[class*="categoryTitle"]')]
                .map(h => ({ name: h.textContent?.trim(), y: docY(h) }))
                .filter(h => h.name && h.name.length < 80)
                .sort((a, b) => a.y - b.y);

            for (const a of justoCards) {
                if (!/\/pedir\/[A-Za-z0-9]+\//.test(a.getAttribute('href') || '')) continue;
                // Prefer img title/alt as clean product name
                const img = a.querySelector('img[title], img[alt]');
                let productName = (img?.getAttribute('title') || img?.getAttribute('alt') || '').trim();
                if (!productName) {
                    // First substantial text line that isn't a discount badge
                    const lines = (a.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
                    productName = lines.find(l => l.length > 3 && !/^-?\d+%$/.test(l) && !/^S\//.test(l)) || '';
                }
                if (!productName || seen.has(productName)) continue;

                const price = parsePrice(a);
                // Some promo cards only show discount % without S/ — skip those without price
                if (price === 0) continue;

                const y = docY(a);
                let category = 'General';
                for (const h of headers) {
                    if (h.y <= y + 5) category = h.name;
                    else break;
                }

                const lines = (a.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
                const description = lines.find(l =>
                    l !== productName && l.length > 10 && !/^S\//.test(l) && !/^-?\d+%$/.test(l)
                ) || '';

                results.push({ restaurant: name, category, name: productName, description, price });
                seen.add(productName);
            }
            if (results.length > 0) return results;
        }

        // Path B: Digifood <article> cards (Wanta / BK-style)
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) {
            const el = walker.currentNode;

            if ((el.tagName === 'H1' || el.tagName === 'H2' || el.tagName === 'H3') &&
                !el.closest('article') && (el.classList?.contains('categoryTitle') || true)) {
                const txt = el.textContent?.trim();
                if (txt && txt.length > 1 && txt.length < 80 &&
                    !/pol[ií]tica|cookie|cuenta|redes|con[oó]cenos/i.test(txt)) {
                    currentCategory = txt;
                }
            }

            if (el.tagName !== 'ARTICLE') continue;

            const nameEl = el.querySelector('h3, h2, h4');
            const productName = nameEl?.textContent?.trim() || '';
            if (!productName || seen.has(productName)) continue;

            const price = parsePrice(el);
            if (price === 0) continue;

            const allPs = Array.from(el.querySelectorAll('p'));
            const descEl = allPs.find(p => !p.textContent.includes('S/'));
            const description = descEl?.textContent?.trim() || '';

            results.push({ restaurant: name, category: currentCategory, name: productName, description, price });
            seen.add(productName);
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
