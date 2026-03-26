const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');
const path = require('path');

async function scrapeMcDonalds(url) {
    console.log(`Iniciando scraping de McDonald's (Own): ${url}`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    // User agent for stealth
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    let catalogData = [];

    // Intercept API calls
    page.on('response', async (res) => {
        if (res.url().includes('/catalog/featured/lite') || res.url().includes('/catalog')) {
            try {
                const json = await res.json();
                if (Array.isArray(json) && json.length > 0 && json[0].products) {
                    catalogData = json;
                }
            } catch (e) {
                // Not JSON or error reading
            }
        }
    });

    try {
        // Go to URL and wait until network is mostly quiet, which means APIs run
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });

        // Wait a few more seconds in case standard networkidle didn't fully capture the fetch
        await page.waitForTimeout(5000);

        if (catalogData.length === 0) {
            // Also try grabbing text from page if our intercept failed
            const bodyHtml = await page.evaluate(() => document.body.innerHTML);
            if (!bodyHtml.includes('S/')) {
                throw new Error("No se pudo encontrar el catálogo por API o en la pantalla. Posible bloqueo de Cloudflare.");
            }
        }

        if (catalogData.length > 0) {
            console.log("Catálogo interceptado desde API interna!");

            // Format to match our other scrapers
            let extractedProducts = [];

            const restaurantMatch = url.match(/\/restaurantes\/[^\/]+\/([^\/]+)/);
            const restaurantName = restaurantMatch ? `McDonalds ${restaurantMatch[1]}` : 'McDonalds Own';

            for (const category of catalogData) {
                for (const product of category.products || []) {
                    extractedProducts.push({
                        restaurant: restaurantName,
                        category: category.title || 'General',
                        name: product.name || '',
                        description: product.description || '',
                        price: (product.price && product.price.amount) ? product.price.amount / 100 : 0,
                        inStock: true // default to true if it shows up
                    });
                }
            }

            // Extract ID for the file
            const storeIdMatch = url.match(/\/([^\/]+)\/pedidos/);
            const storeId = storeIdMatch ? `mcd-${storeIdMatch[1]}` : 'mcd-own';
            saveData(extractedProducts, storeId);
        } else {
            throw new Error("Se cargó la página pero no se detectaron llamadas API válidas de catálogo.");
        }

    } catch (error) {
        console.error(`Error durante el scraping: ${error.message}`);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

function saveData(products, storeId) {
    const jsonPath = path.join(__dirname, `products_${storeId}.json`);
    const csvPath = path.join(__dirname, `products_${storeId}.csv`);

    fs.writeFileSync(jsonPath, JSON.stringify(products, null, 2));
    console.log(`Datos guardados en JSON: ${jsonPath}`);

    const csvHeader = 'Restaurant,Category,Name,Description,Price\n';
    const csvRows = products.map(p => {
        return `"${escapeCsv(p.restaurant)}","${escapeCsv(p.category)}","${escapeCsv(p.name)}","${escapeCsv(p.description)}",${p.price}`;
    }).join('\n');

    fs.writeFileSync(csvPath, csvHeader + csvRows);
    console.log(`Datos guardados en CSV: ${csvPath}`);
}

function escapeCsv(str) {
    if (!str) return "";
    return str.replace(/"/g, '""');
}

const targetUrl = process.argv[2];
if (targetUrl) {
    scrapeMcDonalds(targetUrl);
} else {
    console.log("Uso: node mcdonalds_scraper.js <URL>");
}
