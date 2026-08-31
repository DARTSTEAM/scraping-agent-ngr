// ──────────────────────────────────────────────
// product_matcher.js
// Cross-brand product matching engine.
// For a given NGR brand + channel, uses Gemini (Vertex AI)
// to find, for each NGR (anchor) product, the equivalent
// product in each competitor — with a confidence score and
// alternative suggestions for manual curation.
//
// Pipeline (Week-1 hardening):
//   1. Clean descriptions + tag format (combo/solo/share/duo/side)
//   2. Gemini ranks per (competitor × anchor-chunk)
//   3. Post-gates: format, price ratio, score floor
//   4. 1:1 assignment per competitor product (highest score wins)
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
const CHUNK_SIZE = 20;
const CONCURRENCY = 2;
const MAX_ALTERNATIVES = 3;
const MAX_RETRIES = 5;
const RETRY_BASE_MS = 4000;

/** Description length after cleaning (keep full bill-of-materials when possible). */
const DESC_MAX_CHARS = 300;
/**
 * Floor to keep a candidate as `best` (shown in UI for human review).
 * Below this → no match. Auto-accept still uses REVIEW_THRESHOLD in the dashboard (80).
 */
const SUGGEST_SCORE = 65;
/** Soft target for high-confidence matches (logged / documented; UI uses 80). */
const ACCEPT_SCORE = 80;
/** Reject when max(price)/min(price) exceeds this. */
const MAX_PRICE_RATIO = 2.5;
/** Minimum Jaccard overlap — only enforced when both sides have enough tokens. */
const MIN_TOKEN_OVERLAP = 0.05;

// ──────────────────────────────────────────────
// Description cleaning & format tagging
// ──────────────────────────────────────────────

const DESC_NOISE_PATTERNS = [
  /sujeto\s+a\s+stock[^.]*\.?/gi,
  /stock\s+m[ií]nimo[^.]*\.?/gi,
  /sin\s+posibilidad\s+de\s+excepci[oó]n[^.]*\.?/gi,
  /las\s+gaseosas\s+incluyen\s+hielo[^.]*\.?/gi,
  /im[aá]genes?\s+referenciales?[^.]*\.?/gi,
  /\*?\s*foto\s+referencial\s*\*?[^.]*\.?/gi,
  /disponible\s+sola?\s+o\s+en\s+combo[^.]*\.?/gi,
  /\bRUC\s*\d+\b/gi,
  // Company suffix: one token + "s.a.c" (+ optional RUC), e.g. "Bembos s.a.c ruc 2010…"
  /\b[\w&.]+\s+s\.?\s*a\.?\s*c\.?(?:\s*ruc\s*\d+)?/gi,
  /t[eé]rminos\s+y\s+condiciones[^.]*\.?/gi,
];

/** Strip legal/stock boilerplate so the model sees the bill of materials. */
function cleanDescription(raw) {
  if (!raw) return '';
  let s = String(raw).replace(/\s+/g, ' ').trim();
  for (const re of DESC_NOISE_PATTERNS) s = s.replace(re, ' ');
  s = s.replace(/\s+/g, ' ').replace(/\s*([.,;+])\s*/g, '$1 ').replace(/\s+([.,;+])/g, '$1').trim();
  s = s.replace(/^[,.\s]+|[,.\s]+$/g, '').trim();
  if (s.length <= DESC_MAX_CHARS) return s;
  // Prefer cutting at a separator so we don't clip mid-item.
  const slice = s.slice(0, DESC_MAX_CHARS);
  const cut = Math.max(slice.lastIndexOf(','), slice.lastIndexOf('.'), slice.lastIndexOf('+'), slice.lastIndexOf(';'));
  return (cut > DESC_MAX_CHARS * 0.5 ? slice.slice(0, cut) : slice).trim();
}

/**
 * Coarse product format for hard gates.
 * @returns {'combo'|'duo'|'share'|'side'|'solo'|'unknown'}
 */
function detectFormat(name, description) {
  const text = `${name || ''} ${description || ''}`.toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '');

  const isSide = (
    /^(papa|papas|salsa|salsas|gaseosa|bebida|extra|adicional)\b/.test(text.trim()) ||
    (/\b(papa tumbay|papa mediana|papa familiar|honey mustard|salsa familiar)\b/.test(text) &&
      !/\b(combo|menu|pack|promo|banquete)\b/.test(text))
  );
  if (isSide) return 'side';

  if (/\b(para compartir|pack para\s*\d|banquete|familiar|fiesta\b|mega\s+(promo|futbolero)|chick'?n?\s*share)\b/.test(text)) {
    return 'share';
  }
  if (/\b(duo|dupla|doblete|2x1|dos por|duo\s)/.test(text) || /\bd[uú]o\b/i.test(`${name || ''} ${description || ''}`)) {
    return 'duo';
  }
  if (/\b(combo|mccombo|menu|men[uú]|loncherita|pack\b|promo\b)\b/.test(text)) {
    return 'combo';
  }
  // Bill of materials with 2+ counted items → treat as combo/promo bundle
  const qtyItems = (description || '').match(/\b\d+\s+[A-Za-zÁÉÍÓÚáéíóúñÑ][^,+]*/g);
  if (qtyItems && qtyItems.length >= 2) return 'combo';

  if (!name) return 'unknown';
  return 'solo';
}

/** Formats that must not be crossed. unknown is compatible with everything. */
const FORMAT_INCOMPATIBLE = new Set([
  'solo|combo', 'combo|solo',
  'solo|duo', 'duo|solo',
  'solo|share', 'share|solo',
  'side|combo', 'combo|side',
  'side|duo', 'duo|side',
  'side|share', 'share|side',
  'side|solo', 'solo|side',
  'duo|share', 'share|duo',
  // combo↔duo intentionally allowed — promos often land on either side cross-brand
]);

function formatsCompatible(a, b) {
  if (!a || !b || a === 'unknown' || b === 'unknown') return true;
  if (a === b) return true;
  return !FORMAT_INCOMPATIBLE.has(`${a}|${b}`);
}

const STOP_TOKENS = new Set([
  'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'con', 'en', 'a', 'al',
  'para', 'por', 'o', 'u', 'the', 'and', 'of', 'con', 'sin', 'mas', 'más',
  'grande', 'mediana', 'mediano', 'regular', 'pequeña', 'pequena', 'jr', 'junior',
]);

/** Meaningful tokens from name + cleaned description for overlap checks. */
function contentTokens(name, description) {
  const text = `${name || ''} ${description || ''}`.toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ');
  return new Set(
    text.split(/\s+/)
      .map(t => t.trim())
      .filter(t => t.length >= 3 && !STOP_TOKENS.has(t) && !/^\d+$/.test(t)),
  );
}

function tokenOverlap(a, b) {
  if (!a.size || !b.size) return null; // unknown — don't gate
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

/** Piece counts + coarse protein / food-family cues for content conflicts. */
function extractContentSignals(name, description, category) {
  const text = `${name || ''} ${description || ''} ${category || ''}`.toLowerCase()
    .normalize('NFD').replace(/\p{M}/gu, '');
  const nameLc = `${name || ''}`.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const pieces = [...text.matchAll(/(\d+)\s*(?:pz|pzas?|piezas?|unidades?|u\.?)\b/g)]
    .map(m => Number(m[1]))
    .filter(n => n > 0 && n < 100);
  const qtyLines = [...text.matchAll(/\b(\d+)\s+([a-záéíóúñ][\wáéíóúñ]*)/g)]
    .map(m => ({ qty: Number(m[1]), item: m[2] }))
    .filter(x => x.qty > 0 && x.qty < 50 && x.item.length >= 3 && !STOP_TOKENS.has(x.item));
  const hasChicken = /\b(nugget|mcnugget|pollo|chicken|alitas?|tenders?|wings?|crispy chicken|cajita feliz)\b/.test(text);
  const hasBeef = /\b(carne|res|whopper|royal|cuart[oa]|bacon|parrill|hamburguesa|big mac|mcnifica)\b/.test(text);
  const hasPizza = /\b(pizza|pepperoni|hawaiana|americana|vegetariana)\b/.test(text);
  const hasCoffee = /\b(cafe|café|latte|capuccino|cappuccino|espresso|frap|mocha|doughnut|donut|donas?)\b/.test(text);
  const hasDessert = /\b(helado|postre|shake|milkshake|mcflurry|sundae|cono|ice\s*cream|vainilla|oreo|grimace|flurry)\b/.test(text)
    || /\b(postres|helados)\b/.test(text);
  const isPotatoPlate = /\b(salchipapa|salchinugget)\b/.test(text)
    || (/\b(papa|papas)\b/.test(text) && /\b(hot\s*dog|salchi|frankfurter)\b/.test(text));
  const isCheeseStick = /\b(cheese\s*fingers?|fingers?\s*de\s*queso|dedos?\s*de\s*queso|teque[nñ]os?|mozzarella\s*sticks?|mozarella\s*sticks?)\b/.test(text);
  const isNuggetPlate = /\b(nugget|mcnugget)\b/.test(text)
    && !/\b(salchi|combo|menu|men[uú]|promo)\b/.test(nameLc);
  const isDrink = (
    (/\b(gaseosa|bebida|soda|refresco|coca|sprite|fanta|inca\s*kola|agua|jugo)\b/.test(nameLc)
      || /\bbebidas?\b/.test(`${category || ''}`.toLowerCase()))
    && !hasDessert
    && !hasBeef && !hasChicken
    && !/\b(combo|menu|men[uú]|promo|hamburguesa|papa|nugget|whopper|royal)\b/.test(nameLc)
  );
  const isBreakfast = /\b(desayuno|huevo|tostado|pancake|hash\s*brown|mcmuffin|caf[eé])\b/.test(text)
    || /\bdesayunos?\b/.test(text);
  const isSavorySide = isPotatoPlate || isCheeseStick || isNuggetPlate
    || /\b(complementos?|para acompa[nñ]ar|antojos?)\b/.test(text);
  return {
    pieces: pieces.length ? Math.max(...pieces) : null,
    qtySum: qtyLines.length ? qtyLines.reduce((s, x) => s + x.qty, 0) : null,
    hasChicken,
    hasBeef,
    hasPizza,
    hasCoffee,
    hasDessert,
    isPotatoPlate,
    isCheeseStick,
    isNuggetPlate,
    isDrink,
    isBreakfast,
    isSavorySide,
  };
}

function contentsCompatible(a, b) {
  if (a.pieces != null && b.pieces != null) {
    const hi = Math.max(a.pieces, b.pieces);
    const lo = Math.min(a.pieces, b.pieces);
    if (lo > 0 && hi / lo >= 2) return false;
  }
  if (a.qtySum != null && b.qtySum != null) {
    const hi = Math.max(a.qtySum, b.qtySum);
    const lo = Math.min(a.qtySum, b.qtySum);
    if (lo > 0 && hi / lo >= 2.5) return false;
  }
  if (a.hasChicken && !a.hasBeef && b.hasBeef && !b.hasChicken) return false;
  if (b.hasChicken && !b.hasBeef && a.hasBeef && !a.hasChicken) return false;
  if (a.hasPizza && (b.hasChicken || b.hasBeef || b.hasCoffee || b.hasDessert) && !b.hasPizza) return false;
  if (b.hasPizza && (a.hasChicken || a.hasBeef || a.hasCoffee || a.hasDessert) && !a.hasPizza) return false;
  if (a.hasCoffee && (b.hasBeef || b.hasChicken || b.hasPizza) && !b.hasCoffee) return false;
  if (b.hasCoffee && (a.hasBeef || a.hasChicken || a.hasPizza) && !a.hasCoffee) return false;
  // Dessert / shake never matches savory food
  if (a.hasDessert !== b.hasDessert) return false;
  if (a.isCheeseStick && (b.hasDessert || b.isDrink || b.isBreakfast || b.isNuggetPlate || b.isPotatoPlate || b.hasPizza || b.hasBeef || b.hasChicken || b.hasCoffee)) return false;
  if (b.isCheeseStick && (a.hasDessert || a.isDrink || a.isBreakfast || a.isNuggetPlate || a.isPotatoPlate || a.hasPizza || a.hasBeef || a.hasChicken || a.hasCoffee)) return false;
  if (a.isPotatoPlate && (b.hasDessert || b.isDrink || b.isBreakfast || b.isNuggetPlate || b.isCheeseStick || b.hasBeef || b.hasChicken || b.hasCoffee || b.hasPizza)) return false;
  if (b.isPotatoPlate && (a.hasDessert || a.isDrink || a.isBreakfast || a.isNuggetPlate || a.isCheeseStick || a.hasBeef || a.hasChicken || a.hasCoffee || a.hasPizza)) return false;
  if (a.isNuggetPlate && (b.isPotatoPlate || b.isCheeseStick || b.hasDessert || b.isDrink || b.hasBeef)) return false;
  if (b.isNuggetPlate && (a.isPotatoPlate || a.isCheeseStick || a.hasDessert || a.isDrink || a.hasBeef)) return false;
  if (a.isDrink && !a.hasDessert && (b.hasBeef || b.hasChicken || b.isSavorySide)) return false;
  if (b.isDrink && !b.hasDessert && (a.hasBeef || a.hasChicken || a.isSavorySide)) return false;
  return true;
}

function priceRatioOk(p1, p2) {
  if (typeof p1 !== 'number' || typeof p2 !== 'number' || p1 <= 0 || p2 <= 0) return true;
  return Math.max(p1, p2) / Math.min(p1, p2) <= MAX_PRICE_RATIO;
}

/**
 * Whether an NGR product may be paired with a competitor product.
 * Checks format, cleaned-description content signals, token overlap, and price band.
 */
function pairAllowed(ngrProduct, compProduct) {
  const nDesc = cleanDescription(ngrProduct.description);
  const cDesc = cleanDescription(compProduct.description);
  const nFmt = detectFormat(ngrProduct.name, nDesc);
  const cFmt = detectFormat(compProduct.name, cDesc);
  if (!formatsCompatible(nFmt, cFmt)) return { ok: false, reason: `format ${nFmt}≠${cFmt}` };
  if (!contentsCompatible(
    extractContentSignals(ngrProduct.name, nDesc, ngrProduct.category),
    extractContentSignals(compProduct.name, cDesc, compProduct.category),
  )) {
    return { ok: false, reason: 'content conflict' };
  }
  if (!priceRatioOk(ngrProduct.price, compProduct.price)) {
    return { ok: false, reason: 'price ratio' };
  }
  const overlap = tokenOverlap(
    contentTokens(ngrProduct.name, nDesc),
    contentTokens(compProduct.name, cDesc),
  );
  // Only gate when both sides have enough signal; cross-brand names often share little.
  const nTok = contentTokens(ngrProduct.name, nDesc);
  const cTok = contentTokens(compProduct.name, cDesc);
  if (nTok.size >= 4 && cTok.size >= 4 && overlap != null && overlap < MIN_TOKEN_OVERLAP) {
    return { ok: false, reason: `token overlap ${overlap.toFixed(2)}` };
  }
  return { ok: true };
}

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
  const description = cleanDescription(product.description);
  return {
    ref,
    name: product.name,
    category: product.category || '',
    price: product.price,
    format: detectFormat(product.name, description),
    description,
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
  return `Sos analista de pricing de fast-food en Perú. Para cada producto de la marca "${brandLabel}", encontrá SOLO su equivalente directo en "${competitorName}".

REGLA DE ORO — la descripción manda:
- Equivalente = mismo rol para el cliente: mismos tipos de ítems en la descripción, cantidades/porciones parecidas, mismo formato.
- Compará SIEMPRE las descripciones (bill of materials) antes que el nombre marketing.
- Ejemplos de NO match: "1 Royal + 1 papa" ≠ "6 piezas de pollo"; "Personal Clásica" (ítem suelto) ≠ "Dúo WHOPPER"; promo familiar ≠ combo individual; cheese fingers/tequeños ≠ shakes/helados; salchipapa ≠ nuggets.
- Preferí vacío a un match de otra familia de producto (postre↔salado, papa↔nugget, bebida↔comida).

FORMATO (campo format): combo|duo|share|side|solo.
- Solo cruzá el MISMO format (combo↔duo sí está permitido). Nunca solo↔combo, solo↔duo, side↔comida, share↔solo.

PRECIO: si la diferencia es absurda (>~2×), probablemente no es el mismo producto.

Scoring (sé honesto — el humano revisa 65–79):
- 90-100: descripciones casi idénticas en contenido y formato.
- 80-89: mismo formato, contenidos muy cercanos (tal vez 1 ítem o tamaño distinto) → best seguro.
- 65-79: candidato plausible pero imperfecto → ASIGNALO igual con ese score (revisión manual).
- <65 o sin equivalente real: bestRef "" y bestScore 0.

Devolvé hasta ${MAX_ALTERNATIVES} alternativas ordenadas por score desc. Usá EXCLUSIVAMENTE los "ref" dados.

## Productos "${brandLabel}"
${JSON.stringify(anchorItems)}

## Catálogo de "${competitorName}"
${JSON.stringify(competitorItems)}

JSON: { "results": [ {ngrRef, bestRef, bestScore, alternatives:[{ref,score}]} ] } — un elemento por cada producto de "${brandLabel}".`;
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

function isAuthError(err) {
  const msg = String(err?.message || err || '');
  return /invalid_grant|UNAUTHENTICATED|401|authHeaders|Bad Request/i.test(msg);
}

/** Prefer VERTEX_GCLOUD_ACCOUNT when ADC is stale (common on local). */
function gcloudAccessToken() {
  const { execSync } = require('child_process');
  const account = process.env.VERTEX_GCLOUD_ACCOUNT || '';
  const cmd = account
    ? `gcloud auth print-access-token --account=${account}`
    : 'gcloud auth print-access-token';
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

/** Vertex generateContent via REST — works with a user access token. */
async function callGeminiRest(prompt) {
  const token = gcloudAccessToken();
  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          results: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                ngrRef: { type: 'STRING' },
                bestRef: { type: 'STRING' },
                bestScore: { type: 'NUMBER' },
                alternatives: {
                  type: 'ARRAY',
                  items: {
                    type: 'OBJECT',
                    properties: {
                      ref: { type: 'STRING' },
                      score: { type: 'NUMBER' },
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
      },
      thinkingConfig: { thinkingBudget: 0 },
    },
  };
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  let data;
  try { data = JSON.parse(raw); } catch {
    throw new Error(`Vertex REST non-JSON (${resp.status}): ${raw.slice(0, 200)}`);
  }
  if (!resp.ok) {
    const msg = data?.error?.message || raw.slice(0, 300);
    const err = new Error(msg);
    err.status = resp.status;
    throw err;
  }
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error('Gemini REST devolvió respuesta vacía');
  return {
    json: JSON.parse(text),
    usage: readUsage({ usageMetadata: data.usageMetadata }),
    promptChars: prompt.length,
  };
}

/** Accumulate token usage from a generateContent response (Vertex / AI Studio). */
function readUsage(resp) {
  const u = resp?.usageMetadata || resp?.usage_metadata || {};
  return {
    prompt: Number(u.promptTokenCount ?? u.prompt_token_count ?? 0) || 0,
    candidates: Number(u.candidatesTokenCount ?? u.candidates_token_count ?? 0) || 0,
    total: Number(u.totalTokenCount ?? u.total_token_count ?? 0) || 0,
  };
}

let _preferRest = !!process.env.VERTEX_GCLOUD_ACCOUNT;

async function callGemini(prompt, attempt = 0) {
  try {
    if (_preferRest) return await callGeminiRest(prompt);

    const ai = getAI();
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
    return { json: JSON.parse(text), usage: readUsage(resp), promptChars: prompt.length };
  } catch (err) {
    if (!_preferRest && isAuthError(err)) {
      console.warn('[match] ADC auth falló — usando gcloud access token (REST)');
      _preferRest = true;
      return callGemini(prompt, attempt);
    }
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
// Post-processing gates + 1:1 assignment
// ──────────────────────────────────────────────

/**
 * Build a scored candidate list for one cell, applying hard gates.
 * Returns { best, alternatives } with best already score-gated.
 * No lexical fallback — weak token overlap was pairing cheese sticks with shakes.
 */
function buildGatedCell(ngrProduct, comp, modelResult) {
  const resolve = (ref) => {
    if (!ref) return null;
    const p = comp.byRef.get(ref);
    if (!p) return null;
    return { name: p.name, category: p.category || '', price: p.price, description: p.description || '', _raw: p };
  };

  const ranked = [];
  const push = (ref, score) => {
    const p = resolve(ref);
    if (!p) return;
    const gate = pairAllowed(ngrProduct, p._raw);
    if (!gate.ok) return;
    const s = Math.round(score ?? 0);
    if (s < SUGGEST_SCORE) return;
    if (ranked.some(x => x.name === p.name)) return;
    ranked.push({
      name: p.name,
      category: p.category,
      price: p.price,
      description: p.description,
      score: s,
    });
  };

  if (modelResult) {
    push(modelResult.bestRef, modelResult.bestScore);
    for (const alt of modelResult.alternatives || []) push(alt.ref, alt.score);
  }

  ranked.sort((a, b) => b.score - a.score);

  const best = ranked[0] || null;
  const alternatives = ranked
    .filter(c => !best || c.name !== best.name)
    .slice(0, MAX_ALTERNATIVES);

  return { best, alternatives, _ranked: ranked };
}

/**
 * Ensure each competitor product name is assigned to at most one NGR row
 * (highest score wins). Displaced rows fall back to next unused alternative.
 * @returns {number} how many previously-set bests were cleared by uniqueness
 */
function enforceUniqueAssignments(rows, competitorIds) {
  let dropped = 0;
  for (const compId of competitorIds) {
    const pools = rows.map(row => {
      const cell = row.matches[compId];
      if (!cell) return [];
      return cell._ranked || [
        ...(cell.best ? [cell.best] : []),
        ...(cell.alternatives || []),
      ];
    });

    const claims = [];
    for (let i = 0; i < rows.length; i++) {
      for (const c of pools[i]) {
        if (c.score >= SUGGEST_SCORE) {
          claims.push({ row: i, name: c.name, score: c.score, candidate: c });
        }
      }
    }
    claims.sort((a, b) => b.score - a.score || a.row - b.row);

    const usedProduct = new Set();
    const winnerByRow = new Map();
    for (const claim of claims) {
      if (winnerByRow.has(claim.row)) continue;
      if (usedProduct.has(claim.name)) continue;
      usedProduct.add(claim.name);
      winnerByRow.set(claim.row, claim.candidate);
    }

    for (let i = 0; i < rows.length; i++) {
      const cell = rows[i].matches[compId];
      if (!cell) continue;
      const prevBest = cell.best;
      const win = winnerByRow.get(i) || null;
      if (prevBest && (!win || win.name !== prevBest.name)) dropped++;
      cell.best = win;
      // Keep alternatives for curation UI (may include products assigned elsewhere).
      cell.alternatives = pools[i]
        .filter(c => !win || c.name !== win.name)
        .slice(0, MAX_ALTERNATIVES);
      delete cell._ranked;
    }
  }
  return dropped;
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

  // One task per (competitor × anchor-chunk), bounded concurrency.
  const anchorChunks = chunk(anchorItems, CHUNK_SIZE);
  const tasks = [];
  for (const comp of competitors) {
    for (const ac of anchorChunks) {
      tasks.push({ comp, ac });
    }
  }
  console.log(`[match] ${brandKey}/${channel}: ${tasks.length} llamadas (${MODEL}, concurrency=${CONCURRENCY})…`);

  // ngrRef -> competitorId -> { bestRef, bestScore, alternatives }
  const raw = new Map();
  let failures = 0;
  let lastError = '';
  const usage = { prompt: 0, candidates: 0, total: 0, calls: 0, promptChars: 0 };
  await runPool(tasks, async ({ comp, ac }) => {
    const prompt = buildPrompt(brandKey, comp.name, ac, comp.items);
    let result;
    try {
      result = await callGemini(prompt);
    } catch (err) {
      failures++;
      lastError = err.message;
      console.warn(`[match] fallo ${comp.name} (chunk ${ac.length}): ${err.message}`);
      return;
    }
    usage.prompt += result.usage.prompt;
    usage.candidates += result.usage.candidates;
    usage.total += result.usage.total || (result.usage.prompt + result.usage.candidates);
    usage.promptChars += result.promptChars;
    usage.calls += 1;
    for (const r of result.json.results || []) {
      if (!raw.has(r.ngrRef)) raw.set(r.ngrRef, {});
      raw.get(r.ngrRef)[comp.id] = r;
    }
  }, CONCURRENCY);

  // If every call failed, surface the error instead of writing an empty result.
  if (failures === tasks.length) {
    throw new Error(`El matching falló en todas las llamadas al modelo. Detalle: ${lastError}`);
  }

  let gatedOut = 0;
  const rows = anchorItems.map(a => {
    const ngrProduct = anchorByRef.get(a.ref);
    const perComp = raw.get(a.ref) || {};
    const matches = {};
    for (const comp of competitors) {
      const cell = buildGatedCell(ngrProduct, comp, perComp[comp.id]);
      if (perComp[comp.id]?.bestRef && !cell.best) gatedOut++;
      matches[comp.id] = cell;
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

  const uniqueDropped = enforceUniqueAssignments(rows, competitors.map(c => c.id));
  console.log(`[match] post-gates: ${gatedOut} bests rechazados (formato/precio/contenido/score<${SUGGEST_SCORE}); ${uniqueDropped} reasignados/cleared por 1:1`);
  console.log(`[match] tokens: ${usage.calls} ok calls · in=${usage.prompt} out=${usage.candidates} total=${usage.total} · promptChars=${usage.promptChars}`);

  return {
    brand: brandKey,
    channel,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    acceptScore: ACCEPT_SCORE,
    suggestScore: SUGGEST_SCORE,
    usage,
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
      if (result.usage) {
        console.log(`   tokens in=${result.usage.prompt} out=${result.usage.candidates} total=${result.usage.total}`);
      }
    } catch (err) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  })();
}

module.exports = {
  matchBrand,
  outputPath,
  cleanDescription,
  detectFormat,
  pairAllowed,
  buildGatedCell,
  enforceUniqueAssignments,
  ACCEPT_SCORE,
  SUGGEST_SCORE,
  MAX_PRICE_RATIO,
};
