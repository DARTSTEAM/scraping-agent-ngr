const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

/**
 * Escapes a string for CSV format.
 */
function escapeCsv(str) {
    if (str === null || str === undefined) return '';
    const formatted = String(str).replace(/"/g, '""');
    return `"${formatted}"`;
}

async function scrapeRappi(url) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    console.log(`Navigating to ${url}...`);
    try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    } catch (err) {
        console.error('Error navigating:', err.message);
    }

    console.log('Extracting data from __NEXT_DATA__...');
    const nextData = await page.evaluate(() => {
        const script = document.getElementById('__NEXT_DATA__');
        return script ? JSON.parse(script.textContent) : null;
    });

    if (!nextData) {
        console.error('Could not find __NEXT_DATA__ script tag.');
        await browser.close();
        return;
    }

    const pageProps = nextData.props.pageProps;
    const fallback = pageProps.fallback;

    const storeKey = Object.keys(fallback).find(key => key.includes('restaurant/'));

    if (!storeKey) {
        console.error('Could not find restaurant data in fallback.');
        console.log('Available keys in fallback:', Object.keys(fallback));
        await browser.close();
        return;
    }

    let storeData = fallback[storeKey];
    if (storeData.store) storeData = storeData.store;
    if (!storeData.corridors && storeData.restaurant) storeData = storeData.restaurant;

    const restaurantName = storeData.name || storeData.restaurant_name || 'Unknown Restaurant';
    const corridors = storeData.corridors || [];

    const results = [];

    corridors.forEach(corridor => {
        const categoryName = corridor.name;
        const products = corridor.products || [];

        products.forEach(product => {
            results.push({
                restaurant: restaurantName,
                category: categoryName,
                name: product.name,
                description: product.description,
                price: product.price,
                inStock: product.is_available !== false && product.out_of_stock !== true
            });
        });
    });

    console.log(`Successfully extracted ${results.length} products from ${restaurantName}.`);

    if (results.length > 0) {
        // Create CSV Content
        const headers = ['Restaurant', 'Category', 'Product Name', 'Description', 'Price', 'In Stock'];
        const csvRows = [headers.join(',')];

        results.forEach(row => {
            const values = [
                escapeCsv(row.restaurant),
                escapeCsv(row.category),
                escapeCsv(row.name),
                escapeCsv(row.description),
                row.price,
                row.inStock
            ];
            csvRows.push(values.join(','));
        });

        const csvContent = csvRows.join('\n');

        // Use a cleaner filename for CSV
        const safeStoreId = storeKey.match(/restaurant\/(\d+)/)?.[1] || 'generic';
        const csvFileName = `products_${safeStoreId}.csv`;

        fs.writeFileSync(csvFileName, csvContent, 'utf8');
        console.log(`Results saved to ${csvFileName}`);

        // Also save JSON as backup (optional but good practice)
        fs.writeFileSync(`products_${safeStoreId}.json`, JSON.stringify(results, null, 2));
    }

    await browser.close();
    return results;
}

const targetUrl = process.argv[2] || 'https://www.rappi.com.pe/restaurantes/742-mcdonalds';
scrapeRappi(targetUrl);
