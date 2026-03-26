const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────
// Static frontend (production build)
// ──────────────────────────────────────────────
const DIST_DIR = path.join(__dirname, 'dist');
if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
}

// Path to the directory where scraped product files are stored
// In Cloud Run the data lands in /app (same level as server.cjs)
const RESULTS_DIR = path.join(__dirname, '..');

// Mapping of store IDs to names and platforms (Hardcoded for metadata enrichment)
const STORE_METADATA = {
    '742': { name: "McDonald's - San Antonio", platform: 'Rappi' },
    '6337': { name: "KFC - Surquillo", platform: 'Rappi' },
    '38002': { name: "Starbucks", platform: 'Rappi' },
    'mcd-ovalo-gutierrez': { name: "McDonald's - Ovalo Gutierrez", platform: 'PedidosYa' },
    'mcd-izaguirre-iza': { name: "McDonald's - Izaguirre", platform: 'McDonalds Propio' },
    'pizzahut-miraflores': { name: "Pizza Hut - Miraflores", platform: 'Pizza Hut Propio' }
};

// ──────────────────────────────────────────────
// API – get extracted results
// ──────────────────────────────────────────────
app.get('/api/results', (req, res) => {
    try {
        const files = fs.readdirSync(RESULTS_DIR);
        const jsonFiles = files.filter(f => f.endsWith('.json') && f.startsWith('products_'));

        const data = jsonFiles.map(file => {
            const filePath = path.join(RESULTS_DIR, file);
            const stats = fs.statSync(filePath);
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const storeId = file.match(/products_(.+)\.json/)?.[1] || 'Unknown';

            let detectedPlatform = 'Rappi';
            if (file.includes('pedidosya')) detectedPlatform = 'PedidosYa';
            if (file.includes('mcd-iza') || file.includes('mcd-own')) detectedPlatform = 'McDonalds Propio';
            if (file.includes('pizzahut')) detectedPlatform = 'Pizza Hut Propio';

            const meta = STORE_METADATA[storeId] || {
                name: content[0]?.restaurant || 'Restaurant ' + storeId,
                platform: detectedPlatform
            };

            return {
                id: storeId,
                name: meta.name,
                platform: meta.platform,
                lastUpdated: stats.mtime,
                products: content,
                csvFile: `products_${storeId}.csv`
            };
        });

        res.json(data);
    } catch (error) {
        console.error('Error fetching data:', error);
        res.status(500).json({ error: 'Failed to fetch results' });
    }
});

// ──────────────────────────────────────────────
// API – trigger scraper run
// ──────────────────────────────────────────────
app.post('/api/update', (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    let scriptName = 'rappi_scraper.js';
    if (url.includes('pedidosya.com.pe')) {
        scriptName = 'pedidosya_scraper.js';
    } else if (url.includes('mcdonalds.com.pe')) {
        scriptName = 'mcdonalds_scraper.js';
    } else if (url.includes('pizzahut.com.pe')) {
        scriptName = 'pizzahut_scraper.js';
    }

    const scriptPath = path.join(RESULTS_DIR, scriptName);

    if (!fs.existsSync(scriptPath) && scriptName === 'pedidosya_scraper.js') {
        return res.status(501).json({ error: 'Scraper para PedidosYa en desarrollo (bloqueo por Cloudflare detectado)' });
    }

    if (scriptName === 'pizzahut_scraper.js') {
        return res.status(501).json({ error: 'Scraper para Pizza Hut en desarrollo (bloqueo estricto por Akamai detectado)' });
    }

    console.log(`Starting scraper ${scriptName} for ${url}...`);

    exec(`node "${scriptPath}" "${url}"`, { cwd: RESULTS_DIR }, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error}`);
            return res.status(500).json({ error: 'Scraper execution failed', detail: stderr });
        }
        console.log(`Scraper output: ${stdout}`);
        res.json({ message: 'Scraper finished successfully', output: stdout });
    });
});

// ──────────────────────────────────────────────
// API – download CSV file
// ──────────────────────────────────────────────
app.get('/api/download/:file', (req, res) => {
    const fileName = req.params.file;
    const filePath = path.join(RESULTS_DIR, fileName);

    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// ──────────────────────────────────────────────
// SPA fallback – serve index.html for all other routes
// ──────────────────────────────────────────────
if (fs.existsSync(DIST_DIR)) {
    // Express 5 uses path-to-regexp v8 — wildcard must be {*path}, not bare *
    app.get('{*path}', (_req, res) => {
        res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
