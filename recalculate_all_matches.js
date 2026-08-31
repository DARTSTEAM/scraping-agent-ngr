// Recalculate matches for every brand/channel with data; print token + cost summary.
// Uploads each matches_*.json to GCS so Cloud Run picks them up on next sync/restart.
const fs = require('fs');
const path = require('path');
const { Storage } = require('@google-cloud/storage');
const { BRANDS, getChannelConfig } = require('./brand_config');
const { matchBrand, outputPath } = require('./product_matcher');

// gemini-2.5-flash standard (Vertex / Google AI) — Aug 2026
const PRICE_IN_PER_M = 0.30;
const PRICE_OUT_PER_M = 2.50;
const GCS_BUCKET = process.env.GCS_BUCKET || 'ngr-scraping-data';
const UPLOAD_GCS = process.env.SKIP_GCS_UPLOAD !== '1';

const gcs = new Storage();

function load(id) {
  for (const p of [
    path.join(__dirname, `products_${id}.json`),
    path.join(__dirname, 'data', `products_${id}.json`),
  ]) {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return null;
}

function costUsd(promptTokens, candidateTokens) {
  return (promptTokens / 1e6) * PRICE_IN_PER_M + (candidateTokens / 1e6) * PRICE_OUT_PER_M;
}

async function uploadToGCS(localPath) {
  if (!UPLOAD_GCS) return;
  const fileName = path.basename(localPath);
  await gcs.bucket(GCS_BUCKET).upload(localPath, { destination: fileName });
  console.log(`   [GCS] gs://${GCS_BUCKET}/${fileName}`);
}

async function main() {
  const jobs = [];
  const skipped = [];
  for (const brand of BRANDS) {
    for (const channel of Object.keys(brand.channels)) {
      const cfg = getChannelConfig(brand.key, channel);
      const anchor = load(cfg.anchorId);
      const hasComp = cfg.competitors.some(c => (load(c.id) || []).length > 0);
      if (!anchor?.length || !hasComp) {
        skipped.push(`${brand.key}/${channel}`);
        continue;
      }
      jobs.push({ brand: brand.key, channel });
    }
  }

  console.log(`[batch] ${jobs.length} jobs · skip: ${skipped.join(', ') || '—'}`);
  console.log(`[batch] pricing assumption: $${PRICE_IN_PER_M}/M in · $${PRICE_OUT_PER_M}/M out (${process.env.VERTEX_MODEL || 'gemini-2.5-flash'})`);
  console.log(`[batch] GCS upload: ${UPLOAD_GCS ? GCS_BUCKET : 'skipped (SKIP_GCS_UPLOAD=1)'}`);

  const totals = { prompt: 0, candidates: 0, total: 0, calls: 0, promptChars: 0, usd: 0 };
  const rows = [];
  const t0 = Date.now();

  for (const { brand, channel } of jobs) {
    const jt0 = Date.now();
    process.stdout.write(`\n▶ ${brand}/${channel} … `);
    try {
      const result = await matchBrand(brand, channel);
      const out = outputPath(brand, channel);
      fs.writeFileSync(out, JSON.stringify(result, null, 2));
      try {
        await uploadToGCS(out);
      } catch (uploadErr) {
        console.warn(`   [GCS] upload falló: ${uploadErr.message}`);
      }
      const matched = result.rows.filter(r => Object.values(r.matches).some(m => m.best)).length;
      const u = result.usage || { prompt: 0, candidates: 0, total: 0, calls: 0, promptChars: 0 };
      const usd = costUsd(u.prompt, u.candidates);
      totals.prompt += u.prompt;
      totals.candidates += u.candidates;
      totals.total += u.total;
      totals.calls += u.calls;
      totals.promptChars += u.promptChars;
      totals.usd += usd;
      const line = {
        brand,
        channel,
        ngr: result.rows.length,
        matched,
        calls: u.calls,
        promptTokens: u.prompt,
        outTokens: u.candidates,
        totalTokens: u.total,
        usd: +usd.toFixed(4),
        secs: +((Date.now() - jt0) / 1000).toFixed(1),
      };
      rows.push(line);
      console.log(`ok · ${matched}/${result.rows.length} matched · tokens in=${u.prompt} out=${u.candidates} · $${usd.toFixed(4)} · ${line.secs}s`);
    } catch (err) {
      console.log(`FAIL: ${err.message}`);
      rows.push({ brand, channel, error: err.message });
    }
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    model: process.env.VERTEX_MODEL || 'gemini-2.5-flash',
    priceInPerM: PRICE_IN_PER_M,
    priceOutPerM: PRICE_OUT_PER_M,
    skipped,
    jobs: rows,
    totals: {
      ...totals,
      usd: +totals.usd.toFixed(4),
      elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
    },
  };
  const summaryPath = path.join(__dirname, 'match_batch_usage.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log('\n════════ BATCH SUMMARY ════════');
  console.log(`Calls: ${totals.calls}`);
  console.log(`Tokens in:  ${totals.prompt.toLocaleString()}`);
  console.log(`Tokens out: ${totals.candidates.toLocaleString()}`);
  console.log(`Tokens tot: ${totals.total.toLocaleString()}`);
  console.log(`Est. cost:  $${totals.usd.toFixed(4)}  (@ $${PRICE_IN_PER_M}/M in, $${PRICE_OUT_PER_M}/M out)`);
  console.log(`Elapsed:    ${summary.totals.elapsedSec}s`);
  console.log(`Wrote:      ${summaryPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
