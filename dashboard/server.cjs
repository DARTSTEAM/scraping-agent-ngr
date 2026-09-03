const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const { Storage } = require('@google-cloud/storage');

const { matchBrand } = require('../product_matcher');
const { BRANDS, CHANNELS, getChannelConfig } = require('../brand_config');
const scrapeMeta = require('../scrape_meta');
const { STORES: PEYA_STORES } = require('../pedidosya_stores');

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────
// Paths
// ──────────────────────────────────────────────
const DIST_DIR = path.join(__dirname, 'dist');
const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SCRAPERS_DIR = ROOT_DIR;

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ──────────────────────────────────────────────
// GCS Persistence
// ──────────────────────────────────────────────
const GCS_BUCKET = 'ngr-scraping-data';
const gcs = new Storage();

/**
 * Download all products_*.json from GCS to DATA_DIR.
 * Called once at startup so fresh scrapes survive container restarts.
 */
async function syncFromGCS() {
    // products_* land in data/ (baseline). matches_*/overrides_* land in ROOT_DIR
    // where the matcher writes and reads them.
    const prefixes = [
        { prefix: 'products_',  dir: DATA_DIR },
        { prefix: 'matches_',   dir: ROOT_DIR },
        { prefix: 'overrides_', dir: ROOT_DIR },
        { prefix: 'scrape_meta', dir: ROOT_DIR },
    ];
    for (const { prefix, dir } of prefixes) {
        try {
            const [files] = await gcs.bucket(GCS_BUCKET).getFiles({ prefix });
            let synced = 0;
            for (const file of files) {
                if (!file.name.endsWith('.json')) continue;
                await file.download({ destination: path.join(dir, file.name) });
                synced++;
            }
            console.log(`[GCS] Sincronizados ${synced} archivos '${prefix}*' desde gs://${GCS_BUCKET}`);
        } catch (err) {
            console.warn(`[GCS] No se pudo sincronizar '${prefix}*': ${err.message}`);
        }
    }
}

/**
 * Upload a local JSON file to GCS so it survives container restarts.
 */
async function uploadToGCS(localPath) {
    try {
        const fileName = path.basename(localPath);
        await gcs.bucket(GCS_BUCKET).upload(localPath, { destination: fileName });
        console.log(`[GCS] Subido: gs://${GCS_BUCKET}/${fileName}`);
    } catch (err) {
        console.warn(`[GCS] Error subiendo ${localPath}: ${err.message}`);
    }
}

// GCS sync runs BEFORE the server starts listening.
// This guarantees every user always sees the latest scraped data.

// ──────────────────────────────────────────────
// Static frontend (production build)
// ──────────────────────────────────────────────
if (fs.existsSync(DIST_DIR)) {
    app.use(express.static(DIST_DIR));
}

// Mapping of store IDs to names and platforms
const STORE_METADATA = {
    // ── Rappi – Marcas Propias NGR ──────────────
    '1109':  { name: "Bembos",        platform: 'Rappi' },
    '95275': { name: "Popeyes",       platform: 'Rappi' },
    '61955': { name: "Dunkin'",       platform: 'Rappi' },
    '1121':  { name: "Papa Johns",    platform: 'Rappi' },
    '1190':  { name: "Don Belisario", platform: 'Rappi' },
    '10266': { name: "Chinawok",      platform: 'Rappi' },
    // ── Rappi – Competencia vs. Bembos ──────────
    '742':   { name: "McDonald's",   platform: 'Rappi' },
    '2376':  { name: "Burger King",  platform: 'Rappi' },
    // Rappi – Competencia vs. Popeyes
    '6337':  { name: "KFC",          platform: 'Rappi' },
    '58629': { name: "Yopo",         platform: 'Rappi' },
    // Rappi – Competencia vs. Papa Johns
    '2372':  { name: "Pizza Hut",     platform: 'Rappi' },
    '74738': { name: "Domino's Pizza",platform: 'Rappi' },
    '4136':  { name: "Little Caesars",platform: 'Rappi' },
    // Rappi – Competencia vs. Chinawok
    '73245': { name: "Wanta Chifa",   platform: 'Rappi' },
    '13399': { name: "Chifa Express", platform: 'Rappi' },
    // Rappi – Competencia vs. Dunkin
    '38002': { name: "Starbucks",    platform: 'Rappi' },
    '79108': { name: "Juan Valdez",  platform: 'Rappi' },
    '66914': { name: "Cinnabon",     platform: 'Rappi' },
    // Rappi – Competencia vs. Don Belisario
    '4580':  { name: "Pardos Chicken", platform: 'Rappi' },
    '5341':  { name: "Rokys",          platform: 'Rappi' },
    // ── Propios – Marcas Propias NGR ─────────────
    'bembos-pe':           { name: "Bembos",                    platform: 'Propio' },
    'popeyes-pe':          { name: "Popeyes",                   platform: 'Propio' },
    'dunkin-pe':           { name: "Dunkin'",                   platform: 'Propio' },
    'papajohns-pe':        { name: "Papa Johns",                platform: 'Propio' },
    'donbelisario-pe':     { name: "Don Belisario",             platform: 'Propio' },
    'chinawok-pe':         { name: "Chinawok",                  platform: 'Propio' },
    // ── Propios – Competencia vs. Bembos ────────
    'mcd-benavides-aurora-bau': { name: "McDonald's - Benavides Aurora", platform: 'Propio' },
    'mcd-izaguirre-iza':       { name: "McDonald's - Izaguirre",        platform: 'Propio' },
    'burgerking-pe':       { name: "Burger King",               platform: 'Propio' },
    // Propios – Competencia vs. Popeyes
    'kfc-pe':              { name: "KFC",                       platform: 'Propio' },
    'yopo-pe':             { name: "Yopo",                      platform: 'Propio' },
    // Propios – Competencia vs. Papa Johns
    'pizzahut-miraflores': { name: "Pizza Hut - Miraflores",    platform: 'Propio' },
    'littlecaesars-pe':    { name: "Little Caesars",            platform: 'Propio' },
    // Propios – Competencia vs. Chinawok
    'wanta-pe':            { name: "Wanta",                     platform: 'Propio' },
    'chifaexpress-pe':     { name: "Chifa Express",             platform: 'Propio' },
    // Propios – Competencia vs. Dunkin
    'starbucks-pe':        { name: "Starbucks",                 platform: 'Propio' },
    'cinnabon-pe':         { name: "Cinnabon",                  platform: 'Propio' },
    // Propios – Competencia vs. Don Belisario
    'rokys-pe':            { name: "Rokys",                     platform: 'Propio' },
};

// PedidosYa aggregator stores (same brands as Rappi)
for (const s of PEYA_STORES) {
    if (!s?.id) continue;
    STORE_METADATA[s.id] = { name: s.name, platform: 'PedidosYa' };
}

/**
 * Map scrape target URL → products_<storeId>.json storeId.
 */
function resolveStoreIdFromUrl(url) {
    if (url.includes('pedidosya.com.pe')) {
        const hit = PEYA_STORES.find(s => s.url && url.includes(s.url.split('/').pop()));
        if (hit) return hit.id;
        const byPartial = PEYA_STORES.find(s => s.url && (url.startsWith(s.url) || s.url.startsWith(url)));
        if (byPartial) return byPartial.id;
        // Fallback: match path slug loosely
        const path = (() => { try { return new URL(url).pathname; } catch { return url; } })();
        const soft = PEYA_STORES.find(s => s.url && path && new URL(s.url).pathname.split('/').pop() === path.split('/').pop());
        if (soft) return soft.id;
        return null;
    }

    if (url.includes('papajohns.com.pe')) return 'papajohns-pe';
    if (url.includes('bembos.com.pe')) return 'bembos-pe';
    if (url.includes('popeyes.com.pe')) return 'popeyes-pe';
    if (url.includes('dunkin.pe')) return 'dunkin-pe';
    if (url.includes('donbelisario.com.pe')) return 'donbelisario-pe';
    if (url.includes('chinawok.com.pe')) return 'chinawok-pe';
    if (url.includes('burgerking.pe')) return 'burgerking-pe';
    if (url.includes('kfc.com.pe')) return 'kfc-pe';
    if (url.includes('yopo.pe')) return 'yopo-pe';
    if (url.includes('littlecaesars.com')) return 'littlecaesars-pe';
    if (url.includes('wanta.pe')) return 'wanta-pe';
    if (url.includes('chifaexpress.pe')) return 'chifaexpress-pe';
    if (url.includes('cinnabon.com.pe')) return 'cinnabon-pe';
    if (url.includes('starbucks.pe')) return 'starbucks-pe';
    if (url.includes('rokys.com')) return 'rokys-pe';
    if (url.includes('pizzahut.com.pe')) return 'pizzahut-miraflores';

    if (url.includes('mcdonalds.com.pe')) {
        const m = url.match(/\/([^\/]+)\/pedidos\/?$/);
        if (m) return `mcd-${m[1]}`;
    }

    const rappiMatch = url.match(/restaurantes\/(\d+)/);
    if (rappiMatch) return rappiMatch[1];

    return null;
}

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
        const scrapeTimes = scrapeMeta.load();
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
                local: content[0]?.restaurant || 'Sin información de local',
                // Never use the local mtime: GCS downloads reset it on every deploy.
                lastUpdated: scrapeTimes[storeId] || null,
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

    // PedidosYa is batch-only: manual refresh from the dashboard risks PerimeterX blocks.
    if (url.includes('pedidosya.com.pe')) {
        return res.status(403).json({
            error: 'Actualización manual de PedidosYa deshabilitada. Usá el batch controlado (scrape_pedidosya_batch.js).',
        });
    }

    let scriptName = 'rappi_scraper.js';
    if (url.includes('mcdonalds.com.pe')) {
        scriptName = 'mcdonalds_scraper.js';
    } else if (url.includes('burgerking.pe')) {
        scriptName = 'burgerking_scraper.js';
    } else if (url.includes('kfc.com.pe')) {
        scriptName = 'kfc_scraper.js';
    } else if (url.includes('pizzahut.com.pe')) {
        scriptName = 'pizzahut_scraper.js';
    } else if (url.includes('yopo.pe')) {
        scriptName = 'yopo_scraper.js';
    } else if (url.includes('littlecaesars.com')) {
        scriptName = 'littlecaesars_scraper.js';
    } else if (url.includes('wanta.pe') || url.includes('chifaexpress.pe') || url.includes('cinnabon.com.pe')) {
        scriptName = 'digifood_scraper.js';
    } else if (url.includes('starbucks.pe')) {
        scriptName = 'starbucks_scraper.js';
    } else if (url.includes('rokys.com')) {
        scriptName = 'rokys_scraper.js';
    } else if (url.includes('bembos.com.pe') || url.includes('popeyes.com.pe') ||
               url.includes('papajohns.com.pe') || url.includes('dunkin.pe') ||
               url.includes('donbelisario.com.pe') || url.includes('chinawok.com.pe')) {
        scriptName = 'magento_scraper.js';
    }

    const scriptPath = path.join(SCRAPERS_DIR, scriptName);

    if (!fs.existsSync(scriptPath)) {
        return res.status(501).json({ error: `Scraper ${scriptName} no encontrado` });
    }


    console.log(`Starting scraper ${scriptName} for ${url}…`);

    // Forward KERNEL_API_KEY and sandbox flags to child scraper processes
    const env = {
        ...process.env,
        KERNEL_API_KEY: process.env.KERNEL_API_KEY || '',
        PLAYWRIGHT_CHROMIUM_LAUNCH_OPTIONS: JSON.stringify({ args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    };

    const pedidosYaStoreId = resolveStoreIdFromUrl(url) || 'peya-mcdonalds';
    const scriptArgs = scriptName === 'pedidosya_scraper.js'
        ? `"${scriptPath}" "${url}" "${pedidosYaStoreId}"`
        : `"${scriptPath}" "${url}"`;
    // Per-category browser crawls (Digifood /carta sites, Rokys) do many page loads
    // and need well over 2 min. Kept under Cloud Run's 300s request timeout.
    const HEAVY_SCRAPERS = new Set([
        'kfc_scraper.js', 'burgerking_scraper.js', 'pizzahut_scraper.js',
        'digifood_scraper.js', 'rokys_scraper.js', 'magento_scraper.js',
        'mcdonalds_scraper.js',
    ]);
    const execTimeout = scriptName === 'pedidosya_scraper.js' ? 180000
        : HEAVY_SCRAPERS.has(scriptName) ? 270000
        : 120000;

    // Scraper outputs products_<id>.json to its cwd (SCRAPERS_DIR = /app)
    exec(`node ${scriptArgs}`, { cwd: SCRAPERS_DIR, env, timeout: execTimeout }, async (error, stdout, stderr) => {
        if (error) {
            console.error(`exec error: ${error.message}`);
            return res.status(500).json({ error: 'Scraper execution failed', detail: stderr || error.message });
        }
        console.log(`Scraper output: ${stdout}`);

        // Upload only the scraped store's JSON to GCS and stamp its individual time
        try {
            const targetStoreId = resolveStoreIdFromUrl(url);
            if (!targetStoreId) {
                console.warn(`[scrape_meta] No se pudo resolver storeId para: ${url}`);
            } else {
                const jsonName = `products_${targetStoreId}.json`;
                const rootPath = path.join(SCRAPERS_DIR, jsonName);
                const dataPath = path.join(DATA_DIR, jsonName);
                const localPath = fs.existsSync(rootPath) ? rootPath : dataPath;

                if (fs.existsSync(localPath)) {
                    const stat = fs.statSync(localPath);
                    const scrapedAt = new Date(stat.mtimeMs).toISOString();
                    await uploadToGCS(localPath);
                    const metaPath = scrapeMeta.stamp(targetStoreId, scrapedAt);
                    if (metaPath) await uploadToGCS(metaPath);
                    console.log(`[scrape_meta] stamped ${targetStoreId} @ ${scrapedAt}`);
                } else {
                    console.warn(`[scrape_meta] Archivo no encontrado tras scrape: ${jsonName}`);
                }
            }
        } catch (uploadErr) {
            console.warn(`[GCS] Upload post-scrape fallado: ${uploadErr.message}`);
        }

        res.json({ message: 'Scraper finished successfully', output: stdout });
    });
});

// ──────────────────────────────────────────────
// Price comparison / AI matching
// ──────────────────────────────────────────────

const round2 = (n) => Math.round(n * 100) / 100;

function matchesFilePath(brand, channel) {
    const name = `matches_${brand}_${channel}.json`;
    const inRoot = path.join(ROOT_DIR, name);
    const inData = path.join(DATA_DIR, name);
    if (fs.existsSync(inRoot)) return inRoot;
    if (fs.existsSync(inData)) return inData;
    return null;
}

function overridesFilePath(brand, channel) {
    return path.join(ROOT_DIR, `overrides_${brand}_${channel}.json`);
}

function loadOverrides(brand, channel) {
    const fp = overridesFilePath(brand, channel);
    if (!fs.existsSync(fp)) return {};
    try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; }
}

// Confidence below this drops a match into the manual review queue.
const REVIEW_THRESHOLD = 80;
const overrideKey = (ngrName, competitorId) => `${ngrName}||${competitorId}`;

/** Merge AI matches with human overrides and compute deltas + status per cell. */
function buildComparison(brand, channel) {
    const fp = matchesFilePath(brand, channel);
    if (!fp) return null;
    const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const overrides = loadOverrides(brand, channel);

    const rows = raw.rows.map(row => {
        const cells = {};
        for (const comp of raw.competitors) {
            const cell = row.matches[comp.id] || { best: null, alternatives: [] };
            const ov = overrides[overrideKey(row.ngr.name, comp.id)];

            let best = cell.best;
            let status;
            if (ov) {
                if (ov.action === 'reject') { best = null; status = 'rejected'; }
                else if (ov.action === 'reassign') { best = ov.product; status = 'confirmed'; }
                else { status = 'confirmed'; } // confirm
            } else if (!best) {
                status = 'rejected'; // no candidate — not a review item
            } else {
                status = best.score >= REVIEW_THRESHOLD ? 'auto' : 'pending';
            }

            let delta = null, deltaPct = null;
            if (best && typeof best.price === 'number' && row.ngr.price) {
                delta = round2(row.ngr.price - best.price);
                deltaPct = round2(((row.ngr.price - best.price) / best.price) * 100);
            }
            cells[comp.id] = { best, alternatives: cell.alternatives || [], status, delta, deltaPct, edited: !!ov };
        }
        return { ngr: row.ngr, matches: cells };
    });

    // KPIs: only auto/confirmed matches (pending excluded from price index).
    const kpis = {};
    for (const comp of raw.competitors) {
        let cheaper = 0, pricier = 0, equal = 0, sumNgr = 0, sumComp = 0, matched = 0, pending = 0;
        for (const row of rows) {
            const c = row.matches[comp.id];
            if (c.status === 'pending') { pending++; continue; }
            if (c.status === 'rejected' || !c.best || typeof c.best.price !== 'number' || !row.ngr.price) continue;
            matched++;
            sumNgr += row.ngr.price;
            sumComp += c.best.price;
            if (c.delta > 0.05) pricier++;
            else if (c.delta < -0.05) cheaper++;
            else equal++;
        }
        kpis[comp.id] = {
            matched, pending, cheaper, pricier, equal,
            avgDeltaPct: matched ? round2(((sumNgr - sumComp) / sumComp) * 100) : null,
            priceIndex: sumComp ? round2((sumNgr / sumComp) * 100) : null, // >100 = NGR más caro
        };
    }

    return {
        brand, channel,
        generatedAt: raw.generatedAt || null,
        model: raw.model || null,
        competitors: raw.competitors,
        missingCompetitors: raw.missingCompetitors || [],
        reviewThreshold: REVIEW_THRESHOLD,
        kpis,
        rows,
    };
}

// Full product catalog of one competitor store (for manual reassignment search)
app.get('/api/catalog', (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'id requerido' });
    const inRoot = path.join(SCRAPERS_DIR, `products_${id}.json`);
    const inData = path.join(DATA_DIR, `products_${id}.json`);
    const fp = fs.existsSync(inRoot) ? inRoot : fs.existsSync(inData) ? inData : null;
    if (!fp) return res.status(404).json({ error: `Sin datos para ${id}` });
    try {
        const products = JSON.parse(fs.readFileSync(fp, 'utf8'));
        res.json(products.map(p => ({
            name: p.name,
            category: p.category || '',
            price: p.price,
            description: p.description || '',
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// List brands + channels + whether matches already exist
app.get('/api/brands', (_req, res) => {
    const out = BRANDS.map(b => ({
        key: b.key,
        label: b.label,
        channels: CHANNELS.map(ch => {
            const cfg = b.channels[ch];
            return {
                channel: ch,
                competitors: cfg ? cfg.competitors : [],
                hasMatches: !!matchesFilePath(b.key, ch),
            };
        }),
    }));
    res.json(out);
});

// Read merged comparison (AI + overrides) with deltas + KPIs
app.get('/api/matches', (req, res) => {
    const { brand, channel } = req.query;
    if (!brand || !channel) return res.status(400).json({ error: 'brand y channel son requeridos' });
    try {
        const data = buildComparison(String(brand), String(channel));
        if (!data) return res.status(404).json({ error: 'Sin matches. Usá el engranaje → Recalcular matches, o node product_matcher.js.' });
        res.json(data);
    } catch (err) {
        console.error('Error building comparison:', err);
        res.status(500).json({ error: err.message });
    }
});

// Recalculate matches for a brand+channel via Gemini, persist to GCS
app.post('/api/match', async (req, res) => {
    const { brand, channel } = req.body || {};
    if (!brand || !channel) return res.status(400).json({ error: 'brand y channel son requeridos' });
    if (!getChannelConfig(brand, channel)) return res.status(400).json({ error: 'brand/channel inválido' });
    try {
        console.log(`[match] Recalculando ${brand}/${channel}…`);
        const result = await matchBrand(brand, channel);
        const outPath = path.join(ROOT_DIR, `matches_${brand}_${channel}.json`);
        fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
        await uploadToGCS(outPath);
        const data = buildComparison(brand, channel);
        res.json({ message: 'Matches recalculados', data });
    } catch (err) {
        console.error('Error matching:', err);
        res.status(500).json({ error: err.message });
    }
});

// Persist a human curation decision (confirm / reject / reassign)
app.post('/api/matches/override', async (req, res) => {
    const { brand, channel, ngrName, competitorId, action, product } = req.body || {};
    if (!brand || !channel || !ngrName || !competitorId || !action) {
        return res.status(400).json({ error: 'brand, channel, ngrName, competitorId y action son requeridos' });
    }
    if (!['confirm', 'reject', 'reassign', 'reset'].includes(action)) {
        return res.status(400).json({ error: 'action inválida' });
    }
    try {
        const overrides = loadOverrides(brand, channel);
        const key = overrideKey(ngrName, competitorId);
        if (action === 'reset') {
            delete overrides[key];
        } else {
            overrides[key] = { action, product: action === 'reassign' ? product : undefined, at: new Date().toISOString() };
        }
        const fp = overridesFilePath(brand, channel);
        fs.writeFileSync(fp, JSON.stringify(overrides, null, 2));
        await uploadToGCS(fp);
        res.json({ message: 'Override guardado', data: buildComparison(brand, channel) });
    } catch (err) {
        console.error('Error saving override:', err);
        res.status(500).json({ error: err.message });
    }
});

// ──────────────────────────────────────────────
// API – download CSV
// ──────────────────────────────────────────────
app.get('/api/download/:file', (req, res) => {
    const fileName = req.params.file; // e.g. products_742.csv
    const storeId = fileName.replace(/^products_/, '').replace(/\.csv$/, '');

    // Always regenerate from the JSON source so the CSV is correctly quoted and
    // UTF-8/BOM encoded. Pre-built .csv files written by scrapers are ignored on
    // purpose — they were the origin of the encoding + column-fragmentation issues.
    const jsonInRoot = path.join(SCRAPERS_DIR, `products_${storeId}.json`);
    const jsonInData = path.join(DATA_DIR, `products_${storeId}.json`);
    const jsonPath = fs.existsSync(jsonInRoot) ? jsonInRoot : fs.existsSync(jsonInData) ? jsonInData : null;

    if (!jsonPath) {
        return res.status(404).json({ error: `No data found for ${storeId}` });
    }

    try {
        const products = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

        // Quote every field (handles commas, quotes and newlines inside descriptions
        // so nothing spills into the next column). CRLF line endings for Excel.
        const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
        const num = (v) => (typeof v === 'number' ? v : '');

        const header = ['Local', 'Categoria', 'Producto', 'Descripcion', 'Precio', 'Precio regular', 'Disponible'];
        const rows = products.map(p => [
            cell(p.restaurant),
            cell(p.category),
            cell(p.name),
            cell(p.description),
            num(p.price),
            num(p.originalPrice ?? p.price), // regular price when a promo was captured
            p.inStock === false ? 'No' : p.inStock === true ? 'Si' : '',
        ].join(','));

        // Prepend a UTF-8 BOM so Excel renders tildes/ñ correctly.
        const csv = '﻿' + [header.join(','), ...rows].join('\r\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.send(csv);
    } catch (err) {
        console.error('Error generating CSV:', err);
        res.status(500).json({ error: 'Failed to generate CSV' });
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

(async () => {
    console.log('[GCS] Sincronizando datos antes de arrancar el servidor...');
    await syncFromGCS();
    console.log('[GCS] Sincronización completa. Arrancando servidor...');

    app.listen(port, () => {
        console.log(`Server running on port ${port}`);
        console.log(`Data dir: ${DATA_DIR}`);
        console.log(`Scrapers dir: ${SCRAPERS_DIR}`);
    });
})();
