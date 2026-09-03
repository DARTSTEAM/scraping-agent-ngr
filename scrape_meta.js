const fs = require('fs');
const path = require('path');

const NAME = 'scrape_meta.json';
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');

function metaPath() {
    const inRoot = path.join(ROOT_DIR, NAME);
    const inData = path.join(DATA_DIR, NAME);
    if (fs.existsSync(inRoot)) return inRoot;
    if (fs.existsSync(inData)) return inData;
    return inRoot;
}

function load() {
    const merged = {};
    for (const fp of [path.join(DATA_DIR, NAME), path.join(ROOT_DIR, NAME)]) {
        if (!fs.existsSync(fp)) continue;
        try {
            const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
            for (const [id, ts] of Object.entries(raw)) {
                if (typeof ts !== 'string') continue;
                if (!merged[id] || new Date(ts) > new Date(merged[id])) {
                    merged[id] = ts;
                }
            }
        } catch {
            // ignore corrupt file
        }
    }
    return merged;
}

function stamp(storeIds, scrapedAt = new Date().toISOString()) {
    const ids = (Array.isArray(storeIds) ? storeIds : [storeIds]).filter(Boolean);
    if (ids.length === 0) return null;
    const meta = load();
    for (const id of ids) meta[id] = scrapedAt;
    const fp = path.join(ROOT_DIR, NAME);
    fs.writeFileSync(fp, JSON.stringify(meta, null, 2));
    return fp;
}

module.exports = { NAME, load, stamp, metaPath };
