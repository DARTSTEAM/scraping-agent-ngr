const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * Little Caesars Peru scraper — pe.littlecaesars.com/es-pe/menu/
 * React/Next app. Intercepts menu APIs, falls back to __NEXT_DATA__ and DOM.
 */
async function scrapeLittleCaesars(url = 'https://pe.littlecaesars.com/es-pe/menu/') {
    console.log(`Iniciando scraping de Little Caesars: ${url}`);
    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    let results = [];
    const apiPayloads = [];

    page.on('response', async (res) => {
        const resUrl = res.url();
        if (!/menu|product|catalog|category/i.test(resUrl)) return;
        if (!/\.json|\/api\/|graphql|gateway/i.test(resUrl) && !resUrl.includes('littlecaesars')) return;
        try {
            const ct = res.headers()['content-type'] || '';
            if (!ct.includes('json') && !ct.includes('javascript')) return;
            const json = await res.json();
            if (json && typeof json === 'object') {
                apiPayloads.push(json);
            }
        } catch (_) {}
    });

    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
        await page.waitForTimeout(4000);

        // Dismiss age / cookie / location gates
        await dismissGates(page);
        await page.waitForTimeout(2000);
        await autoScroll(page);
        await page.waitForTimeout(2000);

        // 1) API payloads intercepted during load
        for (const payload of apiPayloads) {
            const fromApi = walkProducts(payload);
            if (fromApi.length > results.length) {
                console.log(`API payload: ${fromApi.length} productos`);
                results = fromApi;
            }
        }

        // 2) __NEXT_DATA__
        if (results.length < 3) {
            const nextData = await page.evaluate(() => {
                const script = document.getElementById('__NEXT_DATA__');
                return script ? JSON.parse(script.textContent) : null;
            });
            if (nextData) {
                console.log('Encontrado __NEXT_DATA__, extrayendo...');
                results = walkProducts(nextData);
            }
        }

        // 3) DOM extraction — LC menu is a single scrollable page with category labels
        if (results.length < 3) {
            console.log('Extrayendo desde DOM...');
            await autoScroll(page);
            results = await extractLCProducts(page, null);
            console.log(`DOM: ${results.length} productos`);
        }

    } catch (err) {
        console.error(`Error: ${err.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    return saveUnique(results, 'littlecaesars-pe');
}

async function dismissGates(page) {
    for (const sel of [
        'button:has-text("Aceptar")', 'button:has-text("Accept")', 'button:has-text("Entendido")',
        'button:has-text("Sí")', 'button:has-text("Continuar")', 'button:has-text("Cerrar")',
        'button:has-text("Ordenar")', 'button:has-text("Order")', '[aria-label="Close"]',
        '[aria-label="Cerrar"]', '.modal-close', '#onetrust-accept-btn-handler',
    ]) {
        try {
            const btn = await page.$(sel);
            if (btn) { await btn.click(); await page.waitForTimeout(500); }
        } catch (_) {}
    }
}

function walkProducts(obj, category = 'General', results = []) {
    if (!obj || typeof obj !== 'object') return results;
    if (Array.isArray(obj)) {
        obj.forEach(item => walkProducts(item, category, results));
        return results;
    }

    const name = obj.name || obj.title || obj.productName;
    const priceRaw = obj.price ?? obj.basePrice ?? obj.unitPrice ?? obj.amount ?? obj.productPrice;
    if (name && priceRaw !== undefined && typeof name === 'string') {
        let price = typeof priceRaw === 'number'
            ? (priceRaw > 1000 ? priceRaw / 100 : priceRaw)
            : parseFloat(String(priceRaw).replace(/[^\d.,]/g, '').replace(',', '.')) || 0;
        if (price > 0 && name.length > 1 && name.length < 120) {
            results.push({
                restaurant: 'Little Caesars',
                category: obj.categoryName || obj.category || category || 'General',
                name,
                description: obj.description || obj.shortDescription || '',
                price,
            });
            return results;
        }
    }

    const catName = typeof (obj.categoryName ?? obj.category ?? obj.name) === 'string'
        ? (obj.categoryName ?? obj.category ?? obj.name)
        : category;
    // Only treat as category context if it looks like a section (has nested products)
    const nextCat = (obj.products || obj.items || obj.menuItems) ? (obj.name || obj.title || catName) : category;
    Object.values(obj).forEach(v => walkProducts(v, typeof nextCat === 'string' ? nextCat : category, results));
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

async function extractLCProducts(page, forcedCategory) {
    return page.evaluate((forcedCat) => {
        const results = [];
        const seen = new Set();

        // LC uses Emotion hashed classes. Compact cards look like:
        //   "S/9.90Hot-N-Ready®CRAZY PUFFS4 Piezas"
        // Prefer mid-level cards (contained in a larger priced parent) — they have
        // cleaner name text without long descriptions.
        const candidates = [...document.querySelectorAll('div')].filter(el => {
            if (el.children.length < 1 || el.children.length > 4) return false;
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t.length < 8 || t.length > 160) return false;
            return /S\/\s*[\d.,]+/.test(t);
        });

        for (const el of candidates) {
            // Keep only mid-level: must be nested inside another candidate
            const hasParentCandidate = candidates.some(o => o !== el && o.contains(el));
            const hasChildCandidate = candidates.some(o => o !== el && el.contains(o));
            if (!hasParentCandidate || hasChildCandidate) continue;

            const raw = (el.textContent || '').replace(/\s+/g, ' ').trim();
            const priceMatch = raw.match(/^S\/\s*([\d.,]+)/);
            if (!priceMatch) continue;
            const price = parseFloat(priceMatch[1].replace(',', '.'));
            if (!price || price <= 0) continue;

            let rest = raw.slice(priceMatch[0].length).trim();
            let category = forcedCat || 'Pizzas';
            if (/^Hot-N-Ready®?/i.test(rest)) {
                category = 'Hot-N-Ready';
                rest = rest.replace(/^Hot-N-Ready®?\s*/i, '');
            }

            // Strip trailing "N Piezas" / glued description starting with lowercase
            let productName = rest
                .replace(/\d+\s*Piezas.*$/i, '')
                .replace(/(?<=[a-záéíóúñ])(?=[A-ZÁÉÍÓÚÑ])/g, '\n') // split CamelGlue
                .split('\n')[0]
                .trim();

            // "Familiar PepperoniPepperoni" → after camel split first part may still
            // be "Familiar Pepperoni" if we split on a-z→A-Z boundary
            if (!productName) productName = rest.slice(0, 40).trim();

            // Final cleanup: drop duplicated trailing word ("Familiar Pepperoni Pepperoni")
            const words = productName.split(/\s+/);
            if (words.length >= 2 && words[words.length - 1].toLowerCase() === words[words.length - 2].toLowerCase()) {
                words.pop();
                productName = words.join(' ');
            }

            if (!productName || productName.length < 2 || seen.has(productName)) continue;
            if (/^(INICIO|MENÚ|MENU|ORDENA|START|S\/)/i.test(productName)) continue;

            results.push({
                restaurant: 'Little Caesars',
                category,
                name: productName,
                description: '',
                price,
            });
            seen.add(productName);
        }

        return results;
    }, forcedCategory || null);
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
