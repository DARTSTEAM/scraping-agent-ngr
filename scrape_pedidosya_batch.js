#!/usr/bin/env node
/**
 * Slow PedidosYa batch scrape — one store at a time with long pauses
 * to reduce PerimeterX / Cloudflare blocks.
 *
 * Usage:
 *   KERNEL_API_KEY=... node scrape_pedidosya_batch.js
 *   KERNEL_API_KEY=... node scrape_pedidosya_batch.js --only=peya-bembos,peya-kfc
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { STORES } = require('./pedidosya_stores');

const PAUSE_MS = Number(process.env.PEYA_PAUSE_MS || 90000); // 90s between stores
const onlyArg = process.argv.find(a => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',').map(s => s.trim()).filter(Boolean) : null;

const queue = STORES.filter(s => s.url && (!only || only.includes(s.id)));

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function runOne(store) {
    return new Promise((resolve) => {
        console.log(`\n======== ${store.id} · ${store.name} ========`);
        console.log(store.url);
        const child = spawn(
            process.execPath,
            [path.join(__dirname, 'pedidosya_scraper.js'), store.url, store.id],
            { cwd: __dirname, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let out = '';
        child.stdout.on('data', d => { const s = d.toString(); out += s; process.stdout.write(s); });
        child.stderr.on('data', d => { const s = d.toString(); out += s; process.stderr.write(s); });
        child.on('close', (code) => {
            const ok = code === 0 && fs.existsSync(path.join(__dirname, `products_${store.id}.json`));
            if (ok) {
                // Keep a copy under data/ for baseline
                try {
                    fs.copyFileSync(
                        path.join(__dirname, `products_${store.id}.json`),
                        path.join(__dirname, 'data', `products_${store.id}.json`)
                    );
                } catch (_) {}
            }
            resolve({ id: store.id, ok, code, out: out.slice(-500) });
        });
    });
}

(async () => {
    console.log(`PedidosYa batch: ${queue.length} stores · pause ${PAUSE_MS / 1000}s`);
    const results = [];
    for (let i = 0; i < queue.length; i++) {
        const store = queue[i];
        const result = await runOne(store);
        results.push(result);
        console.log(result.ok ? `✓ ${store.id}` : `✗ ${store.id} (code ${result.code})`);
        if (i < queue.length - 1) {
            console.log(`Pausa ${PAUSE_MS / 1000}s antes del siguiente…`);
            await sleep(PAUSE_MS);
        }
    }
    const summary = {
        finishedAt: new Date().toISOString(),
        ok: results.filter(r => r.ok).map(r => r.id),
        failed: results.filter(r => !r.ok).map(r => r.id),
    };
    fs.writeFileSync(path.join(__dirname, 'peya_batch_results.json'), JSON.stringify(summary, null, 2));
    console.log('\nDone', summary);
    process.exit(summary.failed.length ? 1 : 0);
})().catch(e => {
    console.error(e);
    process.exit(1);
});
