const { createKernelBrowser, closeKernelBrowser } = require('./kernel_browser');

const fs = require('fs');
const path = require('path');

async function scrapePedidosYa(url) {
    console.log(`Iniciando scraping de PedidosYa: ${url}`);
    console.log(`🌐 Conectando al navegador remoto en Kernel (proxy residencial Perú)...`);

    const { browser, context, kernelBrowser, kernel } = await createKernelBrowser({
        proxy: 'ngr-peru',
        stealth: true,
    });

    const page = await context.newPage();

    try {
        // Navigate with a generous timeout and wait for network to settle
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

        // Wait a bit more for dynamic content
        await page.waitForTimeout(5000);

        // Try to find the data in a script tag (often JSON)
        // PedidosYa often uses a __NEXT_DATA__ or a script with ID "preloaded-state"
        const data = await page.evaluate(() => {
            const nextData = document.getElementById('__NEXT_DATA__');
            if (nextData) return JSON.parse(nextData.textContent);

            const preloaded = Array.from(document.querySelectorAll('script')).find(s => s.textContent.includes('window.__PRELOADED_STATE__'));
            if (preloaded) {
                const text = preloaded.textContent;
                const match = text.match(/window\.__PRELOADED_STATE__\s*=\s*({.+});/);
                if (match) return JSON.parse(match[1]);
            }
            return null;
        });

        if (!data) {
            // Fallback: try to scrape the DOM if JSON not found
            console.log("JSON de datos no encontrado, intentando scraping de DOM...");
            const products = await page.evaluate(() => {
                const items = [];
                // These selectors might vary
                const productElements = document.querySelectorAll('[data-testid="product-card"]');
                productElements.forEach(el => {
                    const name = el.querySelector('[data-testid="product-name"]')?.innerText || '';
                    const description = el.querySelector('[data-testid="product-description"]')?.innerText || '';
                    const priceText = el.querySelector('[data-testid="product-price"]')?.innerText || '0';
                    const price = parseFloat(priceText.replace(/[^\d.]/g, '')) || 0;
                    if (name) {
                        items.push({
                            restaurant: document.title.split('|')[0].trim(),
                            category: "General", // Categorization from DOM is harder
                            name,
                            description,
                            price,
                            inStock: true
                        });
                    }
                });
                return items;
            });

            if (products.length > 0) {
                saveData(products, 'mcd-ovalo-gutierrez');
                return;
            }

            throw new Error("No se pudo extraer información. Es posible que el sitio haya bloqueado el acceso (Cloudflare).");
        }

        // Processing JSON data (This structure is hypothetical based on typical PedidosYa patterns)
        // In real PedidosYa, it's often deep inside the state
        console.log("Datos JSON encontrados, procesando...");

        // This is a placeholder for the actual extraction logic which depends on the exact JSON structure
        // If Cloudflare blocks us, we won't even see this.

        // Final fallback: if we got here but can't find products, throw
        throw new Error("Estructura de datos desconocida o bloqueo detectado.");

    } catch (error) {
        console.error(`Error durante el scraping: ${error.message}`);
        process.exit(1);
    } finally {
        await closeKernelBrowser({ browser, kernelBrowser, kernel });
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
    scrapePedidosYa(targetUrl);
} else {
    console.log("Uso: node pedidosya_scraper.js <URL>");
}
