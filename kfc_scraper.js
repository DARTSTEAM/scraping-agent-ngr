const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');
const fs = require('fs');
const path = require('path');

/**
 * KFC Peru scraper — kfc.com.pe
 *
 * ⚠️  kfc.com.pe está geo-bloqueado por CloudFront para IPs fuera de Perú.
 * Corré este scraper localmente con un VPN configurado en Perú (e.g. Hola VPN → Perú).
 * Una vez generado products_kfc-pe.json, copialo a data/ y hacé commit+push+deploy.
 */
async function scrapeKFC(url = 'https://www.kfc.com.pe/carta') {
    console.log(`Iniciando scraping de KFC: ${url}`);
    console.log(`🌐 Conectando al navegador remoto en Kernel (proxy residencial Perú)...`);

    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();
    const interceptedProducts = [];

    // Intercept API calls for products/menu data
    page.on('response', async (response) => {
        const respUrl = response.url();
        const status = response.status();
        if (status !== 200) return;

        // KFC uses internal endpoints with menu/product data
        if (
            respUrl.includes('/products') ||
            respUrl.includes('/menu') ||
            respUrl.includes('/catalog') ||
            respUrl.includes('/items') ||
            respUrl.includes('/categories')
        ) {
            try {
                const json = await response.json();
                if (Array.isArray(json) && json.length > 0) {
                    console.log(`  [API] Interceptado: ${respUrl} (${json.length} items)`);
                    interceptedProducts.push(...json);
                } else if (json?.products || json?.items || json?.data) {
                    const items = json.products || json.items || json.data;
                    if (Array.isArray(items)) {
                        console.log(`  [API] Interceptado: ${respUrl} (${items.length} items)`);
                        interceptedProducts.push(...items);
                    }
                }
            } catch (_) { /* not JSON */ }
        }
    });

    let results = [];

    try {
        // Step 1: Navigate to homepage first to handle cookies/session
        console.log('Cargando homepage...');
        await page.goto('https://www.kfc.com.pe/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2000);

        // Check for geo-block
        const bodyText = await page.textContent('body').catch(() => '');
        if (bodyText.includes('403') || bodyText.includes('Access Denied') || bodyText.includes('Forbidden')) {
            throw new Error('⛔ Geo-block detectado. Activá Hola VPN (u otro VPN) y configuralo en Perú, luego volvé a correr el scraper.');
        }

        // Dismiss any modals (select store, cookies, etc.)
        const dismissSelectors = [
            '[data-testid="modal-close"]',
            'button[aria-label="Close"]',
            'button[aria-label="Cerrar"]',
            '.modal-close',
            '[class*="close"]',
            '[class*="dismiss"]',
        ];
        for (const sel of dismissSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn) { await btn.click(); await page.waitForTimeout(500); }
            } catch (_) { }
        }

        // Step 2: Navigate to menu/carta page
        console.log('Navegando a la carta...');
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        } catch (_) {
            // If /carta/ver-todo doesn't exist, try /carta
            await page.goto('https://www.kfc.com.pe/carta', { waitUntil: 'domcontentloaded', timeout: 45000 });
        }

        await page.waitForTimeout(3000);

        // Handle store selection modal if present
        await handleStoreModal(page);

        // Step 3: Try DOM-based extraction first
        console.log('Extrayendo productos del DOM...');
        results = await extractProductsFromDOM(page);
        console.log(`  → ${results.length} productos desde DOM`);

        // Step 4: If DOM extraction fails, scroll through all categories
        if (results.length < 5) {
            console.log('DOM extraction insuficiente, navegando por categorías...');
            results = await scrapeByCategories(page);
        }

        // Step 5: If API intercepted something useful, use that
        if (interceptedProducts.length > results.length) {
            console.log(`API interceptó más datos (${interceptedProducts.length} items), procesando...`);
            results = parseAPIProducts(interceptedProducts);
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

    // Deduplicate
    const seen = new Set();
    const unique = results.filter(p => {
        const key = p.name?.trim();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    console.log(`\nTotal de productos únicos extraídos: ${unique.length}`);

    if (unique.length > 0) {
        saveData(unique, 'kfc-pe');
    } else {
        console.error('No se extrajo ningún producto.');
        console.error('Tip: ¿Estás corriendo desde fuera de Perú? Este scraper necesita IP peruana/americana.');
        process.exit(1);
    }

    return unique;
}

async function handleStoreModal(page) {
    try {
        // Wait briefly for modal
        await page.waitForTimeout(1500);

        // Look for "Para llevar" or "Recoge en local" option
        const optionSelectors = [
            'text=Para llevar',
            'text=Recoge en',
            'text=KFC Express',
            '[data-testid*="takeaway"]',
        ];

        for (const sel of optionSelectors) {
            try {
                const btn = await page.$(sel);
                if (btn) {
                    await btn.click();
                    await page.waitForTimeout(1000);
                    break;
                }
            } catch (_) { }
        }

        // Select first available store
        const storeSelectors = [
            '.store-item:first-child',
            '[class*="store"]:first-child button',
            '[class*="location"]:first-child',
        ];
        for (const sel of storeSelectors) {
            try {
                const item = await page.$(sel);
                if (item) {
                    await item.click();
                    await page.waitForTimeout(2000);
                    break;
                }
            } catch (_) { }
        }
    } catch (_) { /* modal may not appear */ }
}

async function extractProductsFromDOM(page) {
    // Scroll progressively to trigger lazy loading
    await page.evaluate(async () => {
        const step = 400;
        const delay = 300;
        let y = 0;
        while (y < document.body.scrollHeight) {
            window.scrollTo(0, y);
            await new Promise(r => setTimeout(r, delay));
            y += step;
        }
        window.scrollTo(0, 0);
    });

    await page.waitForTimeout(1000);

    return page.evaluate(() => {
        const results = [];

        // Strategy 1: article cards (same as BK, same platform Digifood)
        const articles = document.querySelectorAll('article, [class*="product-card"], a[href*="/producto"], a[href*="/product"]');

        articles.forEach(card => {
            const texts = Array.from(card.querySelectorAll('p, span, h3, h2'))
                .map(el => el.textContent?.trim())
                .filter(t => t && t.length > 1);

            const name = texts.find(t => !t.includes('S/') && t.length > 2 && t.length < 100);
            const priceText = texts.find(t => t.includes('S/'));
            const description = texts.find(t =>
                !t.includes('S/') && t.length > 20 && t !== name
            );

            if (!name) return;

            const priceMatch = priceText?.match(/S\/\s*([\d.,]+)/);
            const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : 0;

            // Detect category from nearest section header
            let category = 'General';
            let el = card.parentElement;
            while (el && el !== document.body) {
                const header = el.querySelector('h1, h2, h3');
                if (header && header !== card.querySelector('h2, h3') && header.textContent.trim().length > 1) {
                    category = header.textContent.trim();
                    break;
                }
                el = el.parentElement;
            }

            results.push({ restaurant: 'KFC', category, name, description: description || '', price });
        });

        return results;
    });
}

async function scrapeByCategories(page) {
    const results = [];

    // Get all category links
    const categories = await page.$$eval(
        'a[href*="/carta/"], [class*="category"] a, nav a',
        links => links
            .map(a => ({ href: a.href, text: a.textContent?.trim() }))
            .filter(l => l.href.includes('/carta') && l.text && !l.text.includes('ver-todo'))
    );

    console.log(`  Categorías encontradas: ${categories.length}`);

    for (const cat of categories.slice(0, 15)) { // max 15 categories
        try {
            console.log(`  Procesando categoría: ${cat.text}`);
            await page.goto(cat.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(2000);

            const catProducts = await extractProductsFromDOM(page);
            catProducts.forEach(p => { p.category = cat.text; });
            results.push(...catProducts);

            console.log(`    → ${catProducts.length} productos`);
        } catch (e) {
            console.warn(`    Falló categoría ${cat.text}: ${e.message}`);
        }
    }

    return results;
}

function parseAPIProducts(apiItems) {
    return apiItems
        .filter(item => item.name || item.title || item.productName)
        .map(item => ({
            restaurant: 'KFC',
            category: item.category || item.categoryName || 'General',
            name: item.name || item.title || item.productName || '',
            description: item.description || item.shortDescription || '',
            price: item.price?.amount
                ? item.price.amount / 100
                : (parseFloat(item.price) || parseFloat(item.basePrice) || 0),
        }));
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
