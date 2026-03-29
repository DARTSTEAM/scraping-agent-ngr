const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  console.log("Conectando a tu Google Chrome activo...");
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    
    // Find the KFC page
    const contexts = browser.contexts();
    let kfcPage = null;
    
    for (const ctx of contexts) {
        for (const p of ctx.pages()) {
           if (p.url().includes('kfc.com.pe')) {
               kfcPage = p;
               break;
           }
        }
    }
    
    if (!kfcPage) {
        console.error("No se encontró la pestaña de KFC en tu Chrome!");
        process.exit(1);
    }
    
    console.log("Pestaña de KFC encontrada! Extrayendo datos remotos en vivo...");
    await kfcPage.bringToFront();

    const allProducts = [];
    const seenNames = new Set();
    
    // Wait for categories to be available
    await kfcPage.waitForTimeout(2000);
    
    // Get all category links
    const categories = await kfcPage.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href*="/carta/"], [class*="category"] a, nav a, .menu-item'));
        return links
            .map(a => ({ href: a.href, text: a.innerText?.trim() }))
            .filter(l => l.href && l.href.includes('/carta/') && l.text && l.text.length > 2);
    });
    
    // Deduplicate categories by href
    const uniqueCats = [];
    const seenHrefs = new Set();
    for (let c of categories) {
        if (!seenHrefs.has(c.href)) {
             seenHrefs.add(c.href);
             uniqueCats.push(c);
        }
    }

    console.log(`Se encontraron ${uniqueCats.length} categorías. Navegando una por una...`);
    
    // Fallback if no category links found: we keep the initial 12 and just scroll very slowly
    if (uniqueCats.length === 0) {
        uniqueCats.push({ text: 'General', href: 'current' });
    }

    for (const cat of uniqueCats) {
        console.log(`-> Escaneando categoría: ${cat.text}`);
        
        if (cat.href !== 'current') {
            await kfcPage.goto(cat.href, { timeout: 30000 }).catch(()=>console.log("Timeout but continuing"));
            await kfcPage.waitForTimeout(3000); // give time for react to render and images to lazy load
            await kfcPage.waitForLoadState('networkidle').catch(()=>{});
        }
        
        // Scroll slowly 
        await kfcPage.evaluate(async () => {
            let lastHeight = 0;
            let checks = 0;
            while(checks < 5) {
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise(r => setTimeout(r, 1000));
                let newHeight = document.body.scrollHeight;
                if(newHeight === lastHeight) {
                    checks++;
                } else {
                    checks = 0;
                }
                lastHeight = newHeight;
            }
        });
        
        const products = await kfcPage.evaluate((categoryName) => {
            const articles = document.querySelectorAll('article, [class*="product-card"], a[href*="/producto"], a[href*="/product"]');
            const res = [];
            articles.forEach(card => {
                const texts = Array.from(card.querySelectorAll('p, span, h3, h2')).map(el => el.textContent?.trim()).filter(t => t && t.length > 1);
                const name = texts.find(t => !t.includes('S/') && t.length > 2 && t.length < 100);
                const priceText = texts.find(t => t.includes('S/'));
                if (!name) return;
                const priceMatch = priceText?.match(/S\/\s*([\d.,]+)/);
                const price = priceMatch ? parseFloat(priceMatch[1].replace(',', '.')) : 0;
                
                res.push({ restaurant: 'KFC', category: categoryName, name, description: '', price });
            });
            return res;
        }, cat.text);
        
        for (const p of products) {
            if (!seenNames.has(p.name)) {
                seenNames.add(p.name);
                allProducts.push(p);
            }
        }
        console.log(`   Agregados ${products.length} productos. Total actual: ${allProducts.length}`);
    }

    console.log(`¡Éxito! Se extrajeron FINALMENTE ${allProducts.length} productos.`);
    fs.writeFileSync('./data/products_kfc-pe.json', JSON.stringify(allProducts, null, 2));
    
    // try cleanly disconnect
    try { browser.disconnect(); } catch(e){}
    
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
})();
