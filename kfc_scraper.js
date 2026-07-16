const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * KFC Peru scraper — kfc.com.pe/carta
 *
 * kfc.com.pe runs the same Digifood menu platform as Burger King / Wanta: each
 * category is a route /carta/<slug>. We discover every category (no cap), scrape
 * each with lazy-load scroll + pagination, then a full /carta/ver-todo pass for
 * coverage. Promo prices (struck-through) are handled like the other Digifood sites.
 *
 * ⚠️ kfc.com.pe is geo-blocked by CloudFront outside Peru — runs via the Kernel
 * residential proxy (proxy: ngr-peru).
 */
async function scrapeKFC(url = 'https://www.kfc.com.pe/carta') {
    console.log(`Iniciando scraping de KFC: ${url}`);
    console.log(`🌐 Conectando al navegador remoto en Kernel (proxy residencial Perú)...`);

    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    let results = [];

    try {
        // Step 0: verify the proxy IP is Peruvian
        console.log('[Kernel] Verificando IP del proxy...');
        try {
            await page.goto('https://ipinfo.io/json', { waitUntil: 'domcontentloaded', timeout: 15000 });
            const ipData = JSON.parse(await page.textContent('body').catch(() => '{}'));
            console.log(`[Kernel] IP: ${ipData.ip}, Country: ${ipData.country}, Org: ${ipData.org}`);
            if (ipData.country && ipData.country !== 'PE') {
                console.warn(`[Kernel] ⚠️ La IP NO es de Perú (es de ${ipData.country}).`);
            } else {
                console.log('[Kernel] ✅ IP peruana confirmada.');
            }
        } catch (e) {
            console.warn(`[Kernel] No se pudo verificar la IP: ${e.message}`);
        }

        // Step 1: homepage (session/cookies) + geo-block check
        console.log('Cargando homepage...');
        const homeResponse = await page.goto('https://www.kfc.com.pe/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        const httpStatus = homeResponse?.status();
        console.log(`[KFC] HTTP status homepage: ${httpStatus}`);
        if (httpStatus === 403 || httpStatus === 451) {
            throw new Error(`⛔ Geo-block detectado (HTTP ${httpStatus}). El proxy Kernel no pudo superar CloudFront.`);
        }
        await page.waitForTimeout(2000);
        await dismissModals(page);

        // Step 2: go to the carta and discover categories
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        await page.waitForSelector('article', { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
        await handleStoreModal(page);

        const categories = await page.evaluate(() => {
            const seen = new Map();
            for (const a of document.querySelectorAll('a[href*="/carta/"]')) {
                const href = a.getAttribute('href') || '';
                const m = href.match(/^\/carta\/([a-z0-9-]+)\/?$/i);
                if (!m || m[1].toLowerCase() === 'ver-todo') continue;
                let text = (a.textContent || '').trim();
                const half = text.slice(0, text.length / 2);
                if (text.length % 2 === 0 && half === text.slice(text.length / 2)) text = half;
                if (!seen.has(href) && text) seen.set(href, { href, name: text });
            }
            return [...seen.values()];
        });

        console.log(`Categorías detectadas: ${categories.length} → ${categories.map(c => c.name).join(', ')}`);

        if (categories.length === 0) {
            results = await scrapeCategoryPages(page, 'https://www.kfc.com.pe/carta/ver-todo', 'General');
        } else {
            // 1) Per-category pass (no cap) → real category per product.
            const nameToCategory = new Map();
            for (const cat of categories) {
                const catUrl = cat.href.startsWith('http') ? cat.href : `https://www.kfc.com.pe${cat.href}`;
                const catProducts = await scrapeCategoryPages(page, catUrl, cat.name);
                for (const p of catProducts) if (!nameToCategory.has(p.name)) nameToCategory.set(p.name, cat.name);
            }
            // 2) Full ver-todo pass → complete coverage; tag with mapped category.
            const all = await scrapeCategoryPages(page, 'https://www.kfc.com.pe/carta/ver-todo', 'Otros');
            results = all.map(p => ({ ...p, category: nameToCategory.get(p.name) || 'Otros' }));
            console.log(`Cobertura ver-todo: ${all.length} · con categoría mapeada: ${all.filter(p => nameToCategory.has(p.name)).length}`);
        }

    } catch (error) {
        console.error(`Error: ${error.message}`);
        if (error.message.includes('Geo-block')) {
            await closeKernelBrowser({ browser, kernelBrowser, kernel });
            process.exit(1);
        }
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
    }

    // Dedup by name + category (same item can appear in two categories legitimately).
    const seen = new Set();
    const unique = results.filter(p => {
        const key = `${p.name}||${p.category}`;
        if (!p.name || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`\nTotal de productos únicos extraídos: ${unique.length}`);
    if (unique.length > 0) {
        saveData(unique, 'kfc-pe');
    } else {
        console.error('No se extrajo ningún producto. ¿IP peruana / carta accesible?');
        process.exit(1);
    }
    return unique;
}

// Extract product cards currently rendered → [{name, description, price, originalPrice?}].
async function extractProductsOnPage(page) {
    return page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll('article'));
        const out = [];
        for (const card of cards) {
            const nameEl = card.querySelector('h3, h2, h4');
            const name = nameEl?.textContent?.trim() || '';
            if (!name) continue;

            const allPs = Array.from(card.querySelectorAll('p'));
            const descEl = allPs.find(p => !p.textContent.includes('S/'));
            const description = descEl?.textContent?.trim() || '';

            // struck-through prices are the OLD price
            const striked = new Set();
            card.querySelectorAll('del, s, [class*="line-through"], [class*="old"], [class*="before"]').forEach(se => {
                const m = se.textContent.match(/([\d.,]+)/);
                if (m) striked.add(parseFloat(m[0].replace(',', '.')));
            });

            const prices = [...(card.textContent || '').matchAll(/S\/\s*([\d.,]+)/g)]
                .map(m => parseFloat(m[1].replace(',', '.')))
                .filter(p => !isNaN(p) && p > 0);
            const current = prices.filter(p => !striked.has(p));
            // client-facing price = lowest non-struck value (promo when present)
            const price = current.length ? Math.min(...current) : (prices.length ? Math.min(...prices) : 0);
            const oldPrice = striked.size ? Math.max(...striked) : null;
            if (price === 0) continue;

            out.push({ name, description, price, ...(oldPrice && oldPrice > price ? { originalPrice: oldPrice } : {}) });
        }
        return out;
    });
}

async function autoScroll(page) {
    let prev = -1;
    for (let i = 0; i < 15; i++) {
        const count = await page.evaluate(() => {
            window.scrollTo(0, document.body.scrollHeight);
            return document.querySelectorAll('article').length;
        });
        await page.waitForTimeout(1200);
        if (count === prev) break;
        prev = count;
    }
    await page.evaluate(() => window.scrollTo(0, 0));
}

async function scrapeCategoryPages(page, categoryUrl, categoryName) {
    const out = [];
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    try {
        await page.waitForSelector('article', { timeout: 20000 });
    } catch (_) {
        console.warn(`  ⚠ ${categoryName}: sin artículos, salteando.`);
        return out;
    }
    await page.waitForTimeout(1500);
    for (let guard = 0; guard < 30; guard++) {
        await autoScroll(page);
        out.push(...await extractProductsOnPage(page));
        const nextClicked = await page.evaluate(() => {
            const nextBtn = Array.from(document.querySelectorAll('button, a')).find(b => {
                const text = b.textContent?.trim();
                const label = (b.getAttribute('aria-label') || '').toLowerCase();
                return (text === '>' || text === '›' || text === '→' || text === '»' ||
                    label.includes('siguiente') || label.includes('next'));
            });
            if (nextBtn && !nextBtn.hasAttribute('disabled') && nextBtn.getAttribute('aria-disabled') !== 'true') {
                nextBtn.click();
                return true;
            }
            return false;
        });
        if (!nextClicked) break;
        await page.waitForTimeout(2500);
    }
    // de-dupe within the category by name
    const seen = new Set();
    const deduped = out.filter(p => (seen.has(p.name) ? false : (seen.add(p.name), true)));
    console.log(`  → ${categoryName}: ${deduped.length} productos`);
    return deduped.map(p => ({ ...p, category: categoryName, restaurant: 'KFC' }));
}

async function dismissModals(page) {
    for (const sel of ['[data-testid="modal-close"]', 'button[aria-label="Close"]', 'button[aria-label="Cerrar"]', '.modal-close', '[class*="dismiss"]']) {
        try { const btn = await page.$(sel); if (btn) { await btn.click(); await page.waitForTimeout(400); } } catch (_) {}
    }
}

async function handleStoreModal(page) {
    try {
        await page.waitForTimeout(1500);
        for (const sel of ['text=Para llevar', 'text=Recoge en', 'text=KFC Express', '[data-testid*="takeaway"]']) {
            try { const btn = await page.$(sel); if (btn) { await btn.click(); await page.waitForTimeout(1000); break; } } catch (_) {}
        }
        for (const sel of ['.store-item:first-child', '[class*="store"]:first-child button', '[class*="location"]:first-child']) {
            try { const item = await page.$(sel); if (item) { await item.click(); await page.waitForTimeout(2000); break; } } catch (_) {}
        }
    } catch (_) {}
}

function escapeCsv(str) {
    if (!str) return '""';
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

const targetUrl = process.argv[2] || 'https://www.kfc.com.pe/carta';
scrapeKFC(targetUrl);
