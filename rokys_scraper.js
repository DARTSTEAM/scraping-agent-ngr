const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * Rokys Peru scraper — rokys.com/menu
 * Section headers are lowercase labels in div.relative.items-center.justify-between
 * (e.g. "promociones", "brasas"). Tabs in the top bar scroll to those sections.
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
        // Cookie banner
        try { await page.click('button:has-text("Aceptar")', { timeout: 3000 }); } catch (_) {}
        await page.waitForTimeout(1000);
        await autoScroll(page);

        results = await extractBySectionHeaders(page);
        const catCount = new Set(results.map(r => r.category)).size;
        console.log(`Productos con categoría por sección: ${results.length} · categorías: ${catCount}`);

        if (results.length === 0) {
            const allCards = await extractRokysCards(page);
            results = allCards.map(c => ({
                restaurant: 'Rokys',
                category: 'General',
                name: c.name,
                description: c.description || '',
                price: c.price,
                ...(c.oldPrice && c.oldPrice > c.price ? { originalPrice: c.oldPrice } : {}),
            }));
        }

    } catch (err) {
        console.error(`Error: ${err.message}`);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    return saveUnique(results, 'rokys-pe');
}

/** Assign each card to the nearest section header above it (case-insensitive). */
async function extractBySectionHeaders(page) {
    return page.evaluate(() => {
        const docY = el => el.getBoundingClientRect().top + window.scrollY;
        const KNOWN = [
            'promociones', 'brasas', 'broaster', 'parrillas', 'hamburguesas',
            'wraps', 'tenders', 'fusión criolla', 'fusion criolla',
            'piqueos', 'desayunos', 'bebidas', "cyber rokys", "cyber roky's",
            'los más vendidos', 'los mas vendidos',
        ];

        // Section headers: content blocks with mb-3/mb-4 between product grids
        const headers = [];
        for (const el of document.querySelectorAll('div.relative.items-center, div[class*="justify-between"]')) {
            const t = (el.textContent || '').trim();
            if (!t || t.length > 40 || el.children.length > 3) continue;
            const norm = t.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
            const known = KNOWN.some(k => k.normalize('NFD').replace(/\p{M}/gu, '') === norm);
            if (!known) continue;
            const y = docY(el);
            // Sticky tab bar sits near y≈80; content headers are lower. Allow
            // "los más vendidos" a bit higher (~200+) as the first content block.
            const isMasVendidos = /los m[aá]s vendidos/i.test(t);
            if (y < (isMasVendidos ? 180 : 400)) continue;
            const pretty = t.split(/\s+/).map(w =>
                w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
            ).join(' ');
            headers.push({ name: pretty, y });
        }

        // Deduplicate: keep uppermost header per normalized name in content area,
        // then sort by Y for interval assignment
        headers.sort((a, b) => a.y - b.y);
        const uniqueHeaders = [];
        const seenY = new Set();
        for (const h of headers) {
            const bucket = Math.round(h.y / 30);
            if (seenY.has(h.name + '@' + bucket)) continue;
            seenY.add(h.name + '@' + bucket);
            // Keep first occurrence of each category name (top of its section)
            if (uniqueHeaders.some(u => u.name.toLowerCase() === h.name.toLowerCase())) continue;
            uniqueHeaders.push(h);
        }
        uniqueHeaders.sort((a, b) => a.y - b.y);

        const cards = [...document.querySelectorAll('div[class*="cursor-pointer"]')]
            .filter(el => /S\/\s*\d/.test(el.textContent || '') && el.querySelector('[class*="font-bold"]'));

        const results = [];
        const seen = new Set();
        for (const el of cards) {
            if (cards.some(o => o !== el && o.contains(el))) continue;
            const nameEl = [...el.querySelectorAll('[class*="font-bold"]')]
                .find(n => !/S\/\s*\d/.test(n.textContent) && !/^-?\s?\d{1,3}\s?%$/.test(n.textContent.trim()) && n.textContent.trim().length > 1);
            const name = nameEl?.textContent?.trim();
            if (!name || seen.has(name)) continue;

            const y = docY(el);
            let cat = 'General';
            for (const h of uniqueHeaders) {
                if (h.y <= y + 5) cat = h.name;
                else break;
            }
            // Carousel items above the first section header → first section
            if (cat === 'General' && uniqueHeaders.length > 0) {
                cat = uniqueHeaders[0].name;
            }

            let oldPrice = null;
            const strikeEl = el.querySelector('[class*="line-through"]');
            if (strikeEl) {
                const m = strikeEl.textContent.match(/([\d.,]+)/);
                if (m) oldPrice = parseFloat(m[0].replace(',', '.'));
            }
            const values = [...(el.textContent || '').matchAll(/S\/\s*([\d.,]+)/g)]
                .map(m => parseFloat(m[1].replace(',', '.')))
                .filter(v => !isNaN(v) && v > 0 && v !== oldPrice);
            const price = values[0] || 0;
            if (price === 0) continue;

            const descEl = el.querySelector('p, [class*="desc"]');
            results.push({
                restaurant: 'Rokys',
                category: cat,
                name,
                description: descEl?.textContent?.trim() || '',
                price,
                ...(oldPrice && oldPrice > price ? { originalPrice: oldPrice } : {}),
            });
            seen.add(name);
        }
        return results;
    });
}

async function extractRokysCards(page) {
    return page.evaluate(() => {
        const cards = [...document.querySelectorAll('div[class*="cursor-pointer"]')]
            .filter(el => /S\/\s*\d/.test(el.textContent || '') && el.querySelector('[class*="font-bold"]'));
        const out = [];
        const seen = new Set();
        for (const el of cards) {
            if (cards.some(o => o !== el && o.contains(el))) continue;
            const nameEl = [...el.querySelectorAll('[class*="font-bold"]')]
                .find(n => !/S\/\s*\d/.test(n.textContent) && !/^-?\s?\d{1,3}\s?%$/.test(n.textContent.trim()) && n.textContent.trim().length > 1);
            const name = nameEl?.textContent?.trim() || '';
            if (!name || seen.has(name)) continue;
            let oldPrice = null;
            const strikeEl = el.querySelector('[class*="line-through"]');
            if (strikeEl) {
                const m = strikeEl.textContent.match(/([\d.,]+)/);
                if (m) oldPrice = parseFloat(m[0].replace(',', '.'));
            }
            const values = [...(el.textContent || '').matchAll(/S\/\s*([\d.,]+)/g)]
                .map(m => parseFloat(m[1].replace(',', '.')))
                .filter(v => !isNaN(v) && v > 0 && v !== oldPrice);
            const price = values[0] || 0;
            if (price === 0) continue;
            const descEl = el.querySelector('p, [class*="desc"]');
            out.push({ name, price, oldPrice, description: descEl?.textContent?.trim() || '' });
            seen.add(name);
        }
        return out;
    });
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

function saveUnique(results, storeId) {
    const seen = new Set();
    const unique = results.filter(p => {
        const key = `${p.name}||${p.category}`;
        if (!p.name || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`\nTotal de productos únicos: ${unique.length}`);
    const catCounts = {};
    unique.forEach(p => { catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
    console.log('Categorías:', Object.entries(catCounts).map(([k, v]) => `${k}(${v})`).join(', '));

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
