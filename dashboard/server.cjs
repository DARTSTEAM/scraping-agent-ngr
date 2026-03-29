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
// Paths
// ──────────────────────────────────────────────
const DIST_DIR = path.join(__dirname, 'dist');
// Root of the project (/app in Docker, parent of dashboard/ locally)
const ROOT_DIR = path.join(__dirname, '..');
// Scraped data lives in ROOT/data/ (committed baseline) and ROOT/ (fresh scrapes)
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SCRAPERS_DIR = ROOT_DIR;

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ──────────────────────────────────────────────
// Static frontend (production build)
// ──────────────────────────────────────────────
if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
}

// Mapping of store IDs to names and platforms
const STORE_METADATA = {
    '742': { name: "McDonald's - San Antonio", platform: 'Rappi' },
    '6337': { name: "KFC - Surquillo", platform: 'Rappi' },
    '38002': { name: "Starbucks", platform: 'Rappi' },
    'mcd-ovalo-gutierrez': { name: "McDonald's - Ovalo Gutierrez", platform: 'PedidosYa' },
    'mcd-izaguirre-iza': { name: "McDonald's - Izaguirre", platform: 'McDonalds Propio' },
    'pizzahut-miraflores': { name: "Pizza Hut - Miraflores", platform: 'Pizza Hut Propio' },
    'burgerking-pe': { name: "Burger King", platform: 'Burger King Propio' },
    'kfc-pe': { name: "KFC", platform: 'KFC Propio' }
};

/**
 * Find all products_*.json files, merging data/ (base) with root-level fresh scrapes.
 * Root-level files take priority over data/ when both exist.
 */
function findProductFiles() {
    const seen = new Map(); // storeId -> { filePath, mtime }

    // 1. Load baseline from data/
    if (fs.existsSync(DATA_DIR)) {
        fs.readdirSync(DATA_DIR)
            .filter(f => f.startsWith('products_') && f.endsWith('.json'))
            .forEach(f => {
                const fp = path.join(DATA_DIR, f);
                seen.set(f, { filePath: fp, mtime: fs.statSync(fp).mtime });
            });
    }

    // 2. Fresh scrapes in ROOT_DIR override baseline
    fs.readdirSync(SCRAPERS_DIR)
        .filter(f => f.startsWith('products_') && f.endsWith('.json'))
        .forEach(f => {
            const fp = path.join(SCRAPERS_DIR, f);
            seen.set(f, { filePath: fp, mtime: fs.statSync(fp).mtime });
        });

    return seen;
}

// ──────────────────────────────────────────────
// API – get extracted results
// ──────────────────────────────────────────────
app.get('/api/results', (req, res) => {
    try {
        const files = findProductFiles();
        const data = [];

        for (const [filename, { filePath, mtime }] of files) {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const storeId = filename.match(/products_(.+)\.json/)?.[1] || 'Unknown';

            let detectedPlatform = 'Rappi';
            if (filename.includes('pedidosya')) detectedPlatform = 'PedidosYa';
            if (filename.includes('mcd-iza') || filename.includes('mcd-own')) detectedPlatform = 'McDonalds Propio';
            if (filename.includes('pizzahut')) detectedPlatform = 'Pizza Hut Propio';

            const meta = STORE_METADATA[storeId] || {
                name: content[0]?.restaurant || 'Restaurant ' + storeId,
                platform: detectedPlatform
            };

            data.push({
                id: storeId,
                name: meta.name,
                platform: meta.platform,
                lastUpdated: mtime,
                products: content,
                csvFile: `products_${storeId}.csv`
            });
        }

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
    } else if (url.includes('burgerking.pe')) {
        scriptName = 'burgerking_scraper.js';
    } else if (url.includes('kfc.com.pe')) {
        scriptName = 'kfc_scraper.js';
    } else if (url.includes('pizzahut.com.pe')) {
        // Pizza Hut scraper not ready yet
        return res.status(501).json({ error: 'Scraper para Pizza Hut en desarrollo (bloqueo estricto por Akamai detectado)' });
    }

    const scriptPath = path.join(SCRAPERS_DIR, scriptName);

    if (!fs.existsSync(scriptPath)) {
        return res.status(501).json({ error: `Scraper ${scriptName} no encontrado` });
    }

    // PedidosYa is blocked by Cloudflare
    if (scriptName === 'pedidosya_scraper.js') {
        return res.status(501).json({ error: 'Scraper para PedidosYa en desarrollo (bloqueo por Cloudflare detectado)' });
    }

    console.log(`Starting scraper ${scriptName} for ${url}…`);

    // Forward KERNEL_API_KEY and sandbox flags to child scraper processes
    const env = {
        ...process.env,
        KERNEL_API_KEY: process.env.KERNEL_API_KEY || '',
        PLAYWRIGHT_CHROMIUM_LAUNCH_OPTIONS: JSON.stringify({ args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    };

    // Scraper outputs products_<id>.json to its cwd (SCRAPERS_DIR = /app)
    exec(`node "${scriptPath}" "${url}"`, { cwd: SCRAPERS_DIR, env, timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error.message}`);
            return res.status(500).json({ error: 'Scraper execution failed', detail: stderr || error.message });
        }
        console.log(`Scraper output: ${stdout}`);
        res.json({ message: 'Scraper finished successfully', output: stdout });
    });
});

// ──────────────────────────────────────────────
// API – download CSV
// ──────────────────────────────────────────────
app.get('/api/download/:file', (req, res) => {
    const fileName = req.params.file;

    // Look in root dir first, then data/
    const locations = [path.join(SCRAPERS_DIR, fileName), path.join(DATA_DIR, fileName.replace('.csv', '.json'))];
    const csvPath = path.join(SCRAPERS_DIR, fileName);
    const dataJsonPath = path.join(DATA_DIR, fileName);

    if (fs.existsSync(csvPath)) {
        res.download(csvPath);
    } else if (fs.existsSync(dataJsonPath)) {
        res.download(dataJsonPath);
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// ──────────────────────────────────────────────
// SPA fallback – serve index.html for all other routes
// ──────────────────────────────────────────────
if (fs.existsSync(DIST_DIR)) {
    // Express 5 uses path-to-regexp v8 — wildcard must be {*path}
    app.get('{*path}', (_req, res) => {
        res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
}

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Data dir: ${DATA_DIR}`);
    console.log(`Scrapers dir: ${SCRAPERS_DIR}`);
});
