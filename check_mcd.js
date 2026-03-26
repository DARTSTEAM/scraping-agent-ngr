const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');

async function checkProducts(url) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(5000);
        const text = await page.evaluate(() => document.body.innerHTML);
        fs.writeFileSync('mcd_text.txt', text);
        console.log("Text saved to mcd_text.txt");
    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
    }
}

checkProducts(process.argv[2] || "https://www.mcdonalds.com.pe/restaurantes/independencia/izaguirre-iza/pedidos");
