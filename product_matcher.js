// ──────────────────────────────────────────────
// product_matcher.js
// Cross-brand product matching engine.
// For a given NGR brand + channel, uses Gemini (Vertex AI)
// to find, for each NGR (anchor) product, the equivalent
// product in each competitor — with a confidence score and
// alternative suggestions for manual curation.
//
// Optimized: one focused call PER (competitor × anchor-chunk),
// all fired in parallel. Each prompt carries a single
// competitor's catalog instead of all of them, so prompts are
// small and the whole brand resolves in ~one round-trip.
//
// Output: matches_<brand>_<channel>.json  (written to cwd)
//
// CLI:  node product_matcher.js <brand> <channel>
//       node product_matcher.js bembos rappi
// ──────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { GoogleGenAI, Type } = require('@google/genai');
const { getChannelConfig } = require('./brand_config');

const PROJECT = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || 'hike-fafo';
// Regional endpoint (own quota pool) is more stable than 'global' (dynamic shared
// quota), which was returning persistent 429 RESOURCE_EXHAUSTED.
const LOCATION = process.env.VERTEX_LOCATION || 'us-central1';
const MODEL = process.env.VERTEX_MODEL || 'gemini-2.5-flash';

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');

// Anchor products per model call, and how many calls run at once.
// Concurrency is kept low so we stay under Vertex's per-minute request/token
// quota (429 RESOURCE_EXHAUSTED); transient 429/503 are retried with backoff.
const CHUNK_SIZE = 40;
const CONCURRENCY = 2;
const MAX_ALTERNATIVES = 3;
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 4000;

// ──────────────────────────────────────────────
// Data loading
// ──────────────────────────────────────────────

/** Load products_<id>.json, preferring a fresh scrape in ROOT over the data/ baseline. */
function loadProducts(id) {
  const candidates = [
    path.join(ROOT_DIR, `products_${id}.json`),
    path.join(DATA_DIR, `products_${id}.json`),
  ];
  for (const fp of candidates) {
    if (fs.existsSync(fp)) {
      try {
        return JSON.parse(fs.readFileSync(fp, 'utf8'));
      } catch (err) {
        throw new Error(`products_${id}.json inválido: ${err.message}`);
      }
    }
  }
  return null; // missing data is not fatal — caller decides
}

/** Compact a product to what the model needs, tagged with a stable ref. */
function toCatalogItem(product, ref) {
  return {
    ref,
    name: product.name,
    category: product.category || '',
    price: product.price,
    description: (product.description || '').slice(0, 120),
  };
}

// ──────────────────────────────────────────────
// Concurrency
// ──────────────────────────────────────────────

/** Run `worker` over items with a bounded number of concurrent executions. */
async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    const idx = cursor++;
    if (idx >= items.length) return;
    results[idx] = await worker(items[idx], idx);
    return next();
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, next);
  await Promise.all(runners);
  return results;
}

// ──────────────────────────────────────────────
// Gemini: one competitor per call
// ──────────────────────────────────────────────

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          ngrRef: { type: Type.STRING },
          bestRef: { type: Type.STRING, description: 'ref del mejor equivalente, o "" si no hay' },
          bestScore: { type: Type.NUMBER, description: '0-100 confianza del mejor match' },
          alternatives: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                ref: { type: Type.STRING },
                score: { type: Type.NUMBER },
              },
              required: ['ref', 'score'],
            },
          },
        },
        required: ['ngrRef', 'bestRef', 'bestScore', 'alternatives'],
      },
    },
  },
  required: ['results'],
};

function buildPrompt(brandLabel, competitorName, anchorItems, competitorItems) {
  return `Sos analista de pricing de fast-food en Perú. Para cada producto de la marca "${brandLabel}", encontrá su equivalente en la cadena "${competitorName}".

Equivalente = sustituto directo para el cliente: mismo tipo de ítem, tamaño/porción comparable y mismo formato. Regla dura: combo↔combo, ítem suelto↔ítem suelto, promo para compartir↔promo para compartir. NUNCA cruces un combo con un ítem individual, ni una promo familiar con algo personal. Mirá nombre, descripción, categoría y porciones.

Scoring (sé estricto, no infles):
- 85-100: equivalencia clara (mismo formato y porción).
- 60-84: aproximada (formato igual, porción o contenido algo distinto).
- 1-59: dudosa.
- Si NO hay equivalente razonable: bestRef "" y bestScore 0.

Devolvé además hasta ${MAX_ALTERNATIVES} alternativas (otros candidatos plausibles) ordenadas por score desc. Usá EXCLUSIVAMENTE los valores "ref" dados; nunca inventes uno.

## Productos "${brandLabel}"
${JSON.stringify(anchorItems)}

## Catálogo de "${competitorName}"
${JSON.stringify(competitorItems)}

Devolvé JSON { "results": [ {ngrRef, bestRef, bestScore, alternatives:[{ref,score}]} ] } con un elemento por cada producto de "${brandLabel}".`;
}

let _ai = null;
function getAI() {
  if (!_ai) _ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });
  return _ai;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Retry transient rate-limit / overload errors with exponential backoff + jitter.
function isRetryable(err) {
  const msg = String(err?.message || err || '');
  const code = err?.status ?? err?.code;
  return code === 429 || code === 503 ||
    /RESOURCE_EXHAUSTED|UNAVAILABLE|exhausted|overloaded|rate.?limit|quota/i.test(msg);
}

async function callGemini(prompt, attempt = 0) {
  const ai = getAI();
  try {
    const resp = await ai.models.generateContent({
      model: MODEL,
      contents: prompt,
      config: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        // gemini-2.5-* enables "thinking" by default, which adds large latency.
        // This is a shallow extraction task — disable it for speed.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const text = resp.text;
    if (!text) throw new Error('Gemini devolvió respuesta vacía');
    return JSON.parse(text);
  } catch (err) {
    if (isRetryable(err) && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 1000);
      console.warn(`[match] 429/503, reintento ${attempt + 1}/${MAX_RETRIES} en ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      return callGemini(prompt, attempt + 1);
    }
    throw err;
  }
}

// ──────────────────────────────────────────────
// Matching
// ──────────────────────────────────────────────

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Run matching for one brand + channel.
 * Returns the full matches object (also written to disk by the caller).
 */
async function matchBrand(brandKey, channel) {
  const cfg = getChannelConfig(brandKey, channel);
  if (!cfg) throw new Error(`Marca/canal desconocido: ${brandKey}/${channel}`);

  const anchorProducts = loadProducts(cfg.anchorId);
  if (!anchorProducts || anchorProducts.length === 0) {
    throw new Error(`Sin datos del ancla NGR (products_${cfg.anchorId}.json). Scrapealo primero.`);
  }

  // Build competitor catalogs with stable refs; skip those without data.
  const competitors = [];
  const missing = [];
  for (const comp of cfg.competitors) {
    const products = loadProducts(comp.id);
    if (!products || products.length === 0) { missing.push(comp.name); continue; }
    const byRef = new Map();
    const items = products.map((p, i) => {
      const ref = `${comp.id}#${i}`;
      byRef.set(ref, p);
      return toCatalogItem(p, ref);
    });
    competitors.push({ id: comp.id, name: comp.name, items, byRef });
  }
  if (competitors.length === 0) {
    throw new Error(`Ningún competidor con datos para ${brandKey}/${channel}. Faltan: ${missing.join(', ')}`);
  }

  // Anchor items with stable refs
  const anchorByRef = new Map();
  const anchorItems = anchorProducts.map((p, i) => {
    const ref = `a#${i}`;
    anchorByRef.set(ref, p);
    return toCatalogItem(p, ref);
  });

  // One task per (competitor × anchor-chunk), all run in parallel.
  const anchorChunks = chunk(anchorItems, CHUNK_SIZE);
  const tasks = [];
  for (const comp of competitors) {
    for (const ac of anchorChunks) {
      tasks.push({ comp, ac });
    }
  }
  console.log(`[match] ${brandKey}/${channel}: ${tasks.length} llamadas en paralelo (${MODEL})…`);

  // ngrRef -> competitorId -> { bestRef, bestScore, alternatives }
  const raw = new Map();
  let failures = 0;
  let lastError = '';
  await runPool(tasks, async ({ comp, ac }) => {
    const prompt = buildPrompt(brandKey, comp.name, ac, comp.items);
    let json;
    try {
      json = await callGemini(prompt);
    } catch (err) {
      failures++;
      lastError = err.message;
      console.warn(`[match] fallo ${comp.name} (chunk ${ac.length}): ${err.message}`);
      return;
    }
    for (const r of json.results || []) {
      if (!raw.has(r.ngrRef)) raw.set(r.ngrRef, {});
      raw.get(r.ngrRef)[comp.id] = r;
    }
  }, CONCURRENCY);

  // If every call failed, surface the error instead of writing an empty result.
  if (failures === tasks.length) {
    throw new Error(`El matching falló en todas las llamadas al modelo. Detalle: ${lastError}`);
  }

  // Resolve refs -> concrete products with prices.
  const resolveComp = (comp, ref) => {
    if (!ref) return null;
    const p = comp.byRef.get(ref);
    if (!p) return null;
    return { name: p.name, category: p.category || '', price: p.price, description: p.description || '' };
  };

  const rows = anchorItems.map(a => {
    const ngrProduct = anchorByRef.get(a.ref);
    const perComp = raw.get(a.ref) || {};
    const matches = {};
    for (const comp of competitors) {
      const m = perComp[comp.id];
      let best = null;
      let alternatives = [];
      if (m) {
        const bp = resolveComp(comp, m.bestRef);
        if (bp) best = { ...bp, score: Math.round(m.bestScore ?? 0) };
        alternatives = (m.alternatives || [])
          .map(alt => {
            const ap = resolveComp(comp, alt.ref);
            return ap ? { ...ap, score: Math.round(alt.score ?? 0) } : null;
          })
          .filter(Boolean)
          .filter(alt => !best || alt.name !== best.name)
          .slice(0, MAX_ALTERNATIVES);
      }
      matches[comp.id] = { best, alternatives };
    }
    return {
      ngr: {
        name: ngrProduct.name,
        category: ngrProduct.category || '',
        price: ngrProduct.price,
        description: ngrProduct.description || '',
      },
      matches,
    };
  });

  return {
    brand: brandKey,
    channel,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    competitors: cfg.competitors.map(c => ({
      id: c.id,
      name: c.name,
      hasData: competitors.some(x => x.id === c.id),
    })),
    missingCompetitors: missing,
    rows,
  };
}

function outputPath(brandKey, channel) {
  return path.join(ROOT_DIR, `matches_${brandKey}_${channel}.json`);
}

// ──────────────────────────────────────────────
// CLI
// ──────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const [brandKey, channel] = process.argv.slice(2);
    if (!brandKey || !channel) {
      console.error('Uso: node product_matcher.js <brand> <channel>');
      process.exit(1);
    }
    const t0 = Date.now();
    try {
      const result = await matchBrand(brandKey, channel);
      const outPath = outputPath(brandKey, channel);
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      const matched = result.rows.filter(r => Object.values(r.matches).some(m => m.best)).length;
      console.log(`✅ ${outPath}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
      console.log(`   ${result.rows.length} productos NGR · ${matched} con al menos un match · competidores: ${result.competitors.map(c => c.name + (c.hasData ? '' : ' (sin data)')).join(', ')}`);
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  })();
}

module.exports = { matchBrand, outputPath };
