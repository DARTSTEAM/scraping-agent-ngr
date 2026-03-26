const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');

async function interceptAPI(url) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('response', async (res) => {
        if (res.url().includes('api') || res.url().includes('catalog') || res.url().includes('product')) {
            try {
                const json = await res.json();
                fs.appendFileSync('mcd_api_dump.txt', res.url() + '\n' + JSON.stringify(json).substring(0, 500) + '\n\n');
            } catch (e) { }
        }
    });

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(10000); // give it time to load data
    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
    }
}

interceptAPI(process.argv[2] || "https://www.mcdonalds.com.pe/restaurantes/independencia/izaguirre-iza/pedidos");
