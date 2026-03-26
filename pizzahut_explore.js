const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);
const fs = require('fs');

async function explorePizzaHut(url) {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    page.on('response', async (res) => {
        if (res.url().includes('api') || res.url().includes('catalog') || res.url().includes('product')) {
            try {
                const json = await res.json();
                fs.appendFileSync('pizzahut_api_dump.txt', res.url() + '\n' + JSON.stringify(json).substring(0, 500) + '\n\n');
            } catch (e) { }
        }
    });

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(10000);

        // Let's take a screenshot to see if it asks for address
        await page.screenshot({ path: 'pizzahut_initial.png' });

        // Let's dump the HTML
        const html = await page.evaluate(() => document.body.innerHTML);
        fs.writeFileSync('pizzahut_dump.html', html);

    } catch (e) {
        console.error(e);
    } finally {
        await browser.close();
    }
}

explorePizzaHut("https://www.pizzahut.com.pe/order");
