const { chromium } = require('playwright');
const fs = require('fs');

async function dumpHTML(url) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(5000);
        const html = await page.content();
        fs.writeFileSync('mcd_dump.html', html);
        console.log("Dumped to mcd_dump.html");
    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
    }
}

dumpHTML(process.argv[2] || "https://www.mcdonalds.com.pe/restaurantes/independencia/izaguirre-iza/pedidos");
