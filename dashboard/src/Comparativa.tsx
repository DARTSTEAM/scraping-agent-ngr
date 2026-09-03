import { useState, useEffect, useMemo, Fragment, useRef } from 'react';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  Cog6ToothIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  MinusIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { formatPeruDateTime } from './formatDate';

const API_BASE = '/api';

interface Product { name: string; category: string; price: number; description?: string; score?: number; }
type Status = 'auto' | 'pending' | 'confirmed' | 'rejected';
interface Cell {
  best: (Product & { score: number }) | null;
  alternatives: (Product & { score: number })[];
  status: Status;
  delta: number | null;
  deltaPct: number | null;
  edited: boolean;
}
interface Row { ngr: Product; matches: Record<string, Cell>; }
interface Kpi { matched: number; pending: number; cheaper: number; pricier: number; equal: number; avgDeltaPct: number | null; priceIndex: number | null; }
interface Competitor { id: string; name: string; hasData?: boolean; }
interface Comparison {
  brand: string; channel: string; generatedAt: string | null; model: string | null;
  competitors: Competitor[]; missingCompetitors: string[]; reviewThreshold: number;
  kpis: Record<string, Kpi>; rows: Row[];
}
interface BrandInfo {
  key: string; label: string;
  channels: { channel: string; competitors: Competitor[]; hasMatches: boolean }[];
}

const CHANNEL_LABEL: Record<string, string> = { rappi: 'Rappi', propio: 'Sitio Propio' };
const money = (n: number | null | undefined) => (typeof n === 'number' ? `S/ ${n.toFixed(2)}` : '—');

const STATUS_BADGE: Record<Status, { label: string; cls: string }> = {
  auto:      { label: 'IA',         cls: 'bg-slate-100 text-slate-500' },
  pending:   { label: 'Revisar',    cls: 'bg-amber-100 text-amber-700' },
  confirmed: { label: 'Confirmado', cls: 'bg-emerald-100 text-emerald-700' },
  rejected:  { label: 'Sin equiv.', cls: 'bg-rose-100 text-rose-600' },
};

export default function Comparativa() {
  const [brands, setBrands] = useState<BrandInfo[]>([]);
  const [brand, setBrand] = useState('');
  const [channel, setChannel] = useState<'rappi' | 'propio'>('rappi');
  const [data, setData] = useState<Comparison | null>(null);
  const [subTab, setSubTab] = useState<'dashboard' | 'review'>('dashboard');
  const [loading, setLoading] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [error, setError] = useState('');
  const [onlyPending, setOnlyPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    axios.get<BrandInfo[]>(`${API_BASE}/brands`).then(r => {
      setBrands(r.data);
      if (r.data.length && !brand) setBrand(r.data[0].key);
    }).catch(() => setError('No se pudo cargar la lista de marcas.'));
  }, []);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [settingsOpen]);

  const fetchMatches = async () => {
    if (!brand) return;
    setLoading(true); setError('');
    try {
      const r = await axios.get<Comparison>(`${API_BASE}/matches`, { params: { brand, channel } });
      setData(r.data);
    } catch (err: any) {
      setData(null);
      if (err.response?.status !== 404) setError(err.response?.data?.error || 'Error al cargar matches.');
    } finally { setLoading(false); }
  };

  useEffect(() => { fetchMatches(); }, [brand, channel]);

  const recalcular = async () => {
    setSettingsOpen(false);
    setRecalculating(true); setError('');
    try {
      const r = await axios.post(`${API_BASE}/match`, { brand, channel });
      setData(r.data.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al recalcular. ¿Hay datos scrapeados de esta marca y sus competidores?');
    } finally { setRecalculating(false); }
  };

  const applyOverride = async (ngrName: string, competitorId: string, action: string, product?: Product) => {
    try {
      const r = await axios.post(`${API_BASE}/matches/override`, { brand, channel, ngrName, competitorId, action, product });
      setData(r.data.data);
    } catch (err: any) {
      setError(err.response?.data?.error || 'Error al guardar la decisión.');
      throw err;
    }
  };

  const currentBrand = brands.find(b => b.key === brand);
  const competitors = data?.competitors || [];

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1 tracking-wider">Marca NGR</label>
            <select
              value={brand}
              onChange={e => setBrand(e.target.value)}
              className="pl-3 pr-8 py-2 bg-slate-50 border-0 rounded-xl text-slate-900 font-bold focus:ring-2 focus:ring-slate-200 cursor-pointer"
            >
              {brands.map(b => <option key={b.key} value={b.key}>{b.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1 tracking-wider">Canal</label>
            <div className="flex bg-slate-100 rounded-xl p-1">
              {(['rappi', 'propio'] as const).map(ch => (
                <button
                  key={ch}
                  onClick={() => setChannel(ch)}
                  className={`px-4 py-1.5 rounded-lg text-sm font-bold transition-all cursor-pointer ${channel === ch ? 'bg-white shadow-sm text-slate-900' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  {CHANNEL_LABEL[ch]}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 self-end lg:self-auto">
          {data?.generatedAt && (
            <span className="text-[11px] text-slate-400 font-medium">
              Último cálculo: {formatPeruDateTime(data.generatedAt)}
            </span>
          )}
          {recalculating && (
            <span className="text-[11px] text-slate-500 font-medium animate-pulse">Cruzando con IA…</span>
          )}
          <div className="relative" ref={settingsRef}>
            <button
              type="button"
              onClick={() => setSettingsOpen(o => !o)}
              aria-label="Opciones de matching"
              aria-expanded={settingsOpen}
              className="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-50 transition-colors cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
            >
              <Cog6ToothIcon className={`w-5 h-5 ${recalculating ? 'animate-spin' : ''}`} />
            </button>
            {settingsOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 min-w-[220px] rounded-xl border border-slate-200 bg-white py-1 shadow-sm">
                <button
                  type="button"
                  onClick={recalcular}
                  disabled={recalculating || !brand}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50 cursor-pointer"
                >
                  <ArrowPathIcon className={`w-4 h-4 shrink-0 ${recalculating ? 'animate-spin' : ''}`} />
                  {recalculating ? 'Recalculando…' : 'Recalcular matches'}
                </button>
                <p className="px-3 pb-2 text-[10px] leading-snug text-slate-400">
                  Vuelve a cruzar NGR vs competidores con Gemini. Puede tardar y consumir tokens.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-rose-50 border border-rose-100 text-rose-700 rounded-xl px-4 py-3 text-sm font-medium">
          <ExclamationTriangleIcon className="w-5 h-5 shrink-0" /> {error}
        </div>
      )}

      {/* Sub-tabs */}
      {data && (
        <div className="flex border-b border-slate-200">
          {(['dashboard', 'review'] as const).map(t => (
            <button
              key={t}
              onClick={() => setSubTab(t)}
              className={`px-6 py-3 font-bold text-sm transition-all border-b-2 cursor-pointer ${subTab === t ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
            >
              {t === 'dashboard' ? 'Dashboard' : `Revisión manual${data ? ` (${totalPending(data)})` : ''}`}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="py-24 text-center text-slate-300 italic">Cargando comparativa…</div>
      ) : !data ? (
        <EmptyState
          brandLabel={currentBrand?.label}
          channel={channel}
          onRecalc={recalcular}
          recalculating={recalculating}
        />
      ) : subTab === 'dashboard' ? (
        <Dashboard data={data} competitors={competitors} brandLabel={currentBrand?.label || data.brand} />
      ) : (
        <Review data={data} competitors={competitors} onlyPending={onlyPending} setOnlyPending={setOnlyPending}
                applyOverride={applyOverride} />
      )}
    </div>
  );
}

function totalPending(data: Comparison) {
  return data.rows.reduce((acc, row) =>
    acc + Object.values(row.matches).filter(c => c.status === 'pending').length, 0);
}

function EmptyState({ brandLabel, channel, onRecalc, recalculating }: {
  brandLabel?: string;
  channel: string;
  onRecalc: () => void;
  recalculating: boolean;
}) {
  return (
    <div className="bg-white rounded-2xl border border-dashed border-slate-200 py-20 text-center space-y-3 px-6">
      <div>
        <p className="text-slate-600 font-bold">Todavía no hay cruce para {brandLabel} en {CHANNEL_LABEL[channel]}</p>
        <p className="text-slate-400 text-sm mt-1 max-w-md mx-auto">
          Generá el matching desde el ícono de engranaje arriba a la derecha, o con{' '}
          <code className="text-slate-500">node product_matcher.js</code>.
        </p>
      </div>
      <button
        type="button"
        onClick={onRecalc}
        disabled={recalculating}
        className="text-sm font-semibold text-slate-500 underline-offset-2 hover:text-slate-800 hover:underline disabled:opacity-50 cursor-pointer"
      >
        {recalculating ? 'Cruzando con IA…' : 'Recalcular matches'}
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────
// Dashboard
// ──────────────────────────────────────────────
// Variation of NGR vs competitor: (ngr − comp) / comp.
// +% = NGR pricier (rose) · −% = NGR cheaper (emerald). Same formula as KPI/scatter.
function variationPct(ngrPrice: number | undefined, compPrice: number | null | undefined): number | null {
  if (!ngrPrice || typeof compPrice !== 'number' || compPrice <= 0) return null;
  return ((ngrPrice - compPrice) / compPrice) * 100;
}

function VariationBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-300">—</span>;
  const pricier = pct > 0.05, cheaper = pct < -0.05;
  const cls = pricier ? 'text-rose-600' : cheaper ? 'text-emerald-600' : 'text-slate-400';
  const Icon = pricier ? ArrowUpIcon : cheaper ? ArrowDownIcon : MinusIcon;
  return (
    <span className={`inline-flex items-center justify-end gap-0.5 font-bold tabular-nums ${cls}`}>
      <Icon className="w-3.5 h-3.5" />{Math.abs(pct).toFixed(0)}%
    </span>
  );
}

/** Price KPIs / scatter only use auto or human-confirmed matches. */
function isPriceReady(cell?: Cell | null): boolean {
  return !!cell?.best && (cell.status === 'auto' || cell.status === 'confirmed');
}

// Validated categorical palette (dataviz skill), fixed order per competitor.
const SERIES_COLORS = ['#2a78d6', '#1baf7a', '#eda100', '#4a3aa7', '#e34948'];

const clampN = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * pow;
}

// Scatter: X = NGR price, Y = variation of NGR vs competitor (%). Above 0 = NGR
// pricier (rose band); below 0 = NGR cheaper (emerald band). One color per competitor.
function PriceScatter({ rows, comps, brandLabel }: { rows: Row[]; comps: Competitor[]; brandLabel: string }) {
  const [tip, setTip] = useState<{ x: number; y: number; lines: string[]; color: string } | null>(null);

  const points = useMemo(() => {
    const pts: { price: number; pct: number; color: string; name: string; compName: string; compPrice: number; compLabel: string }[] = [];
    comps.forEach((c, ci) => {
      const color = SERIES_COLORS[ci % SERIES_COLORS.length];
      for (const row of rows) {
        const cell = row.matches[c.id];
        if (!isPriceReady(cell)) continue;
        const p = cell!.best!.price;
        if (typeof p === 'number' && row.ngr.price) {
          const pct = variationPct(row.ngr.price, p);
          if (pct == null) continue;
          pts.push({
            price: row.ngr.price, pct, color,
            name: row.ngr.name, compName: cell!.best!.name, compPrice: p, compLabel: c.name,
          });
        }
      }
    });
    return pts;
  }, [rows, comps]);

  const W = 760, H = 360, m = { top: 14, right: 18, bottom: 46, left: 54 };
  const iw = W - m.left - m.right, ih = H - m.top - m.bottom;
  const zeroY = m.top + ih / 2;

  const xMax = niceCeil(Math.max(10, ...points.map(p => p.price)));
  // Fixed ±100% axis; outliers are drawn at the edge (still show real % in tooltip).
  const D = 100;

  const xOf = (price: number) => m.left + (price / xMax) * iw;
  const yOf = (pct: number) => zeroY - (clampN(pct, -D, D) / D) * (ih / 2);

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round(t * xMax));
  const yTicks = [D, D / 2, 0, -D / 2, -D];

  if (points.length === 0) {
    return <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm text-center text-slate-400 italic py-12">Sin matches para graficar.</div>;
  }

  return (
    <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <div>
          <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em]">Dispersión de precios</h2>
          <p className="text-[11px] text-slate-400 mt-0.5">cada punto = un producto · Y: {brandLabel} vs competidor (%), eje ±100% (outliers al borde) · X: precio {brandLabel} (S/)</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {comps.map((c, ci) => (
            <span key={c.id} className="inline-flex items-center gap-1.5 text-[11px] font-bold text-slate-600">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: SERIES_COLORS[ci % SERIES_COLORS.length] }} />
              {c.name}
            </span>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Dispersión de variación de precio por producto">
        {/* polarity bands */}
        <rect x={m.left} y={m.top} width={iw} height={ih / 2} fill="#fef2f2" />
        <rect x={m.left} y={zeroY} width={iw} height={ih / 2} fill="#f0fdf4" />

        {/* gridlines + y ticks */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={m.left} x2={m.left + iw} y1={yOf(t)} y2={yOf(t)} stroke={t === 0 ? '#94a3b8' : '#e1e0d9'} strokeWidth={t === 0 ? 1.5 : 1} />
            <text x={m.left - 8} y={yOf(t) + 3} textAnchor="end" className="fill-slate-400" fontSize="10" fontWeight="700">{t > 0 ? '+' : ''}{t}%</text>
          </g>
        ))}
        {/* x ticks */}
        {xTicks.map((t, i) => (
          <g key={i}>
            <text x={xOf(t)} y={m.top + ih + 16} textAnchor="middle" className="fill-slate-400" fontSize="10" fontWeight="700">{t}</text>
          </g>
        ))}
        <line x1={m.left} x2={m.left + iw} y1={m.top + ih} y2={m.top + ih} stroke="#c3c2b7" strokeWidth="1" />

        {/* axis titles */}
        <text x={m.left + iw / 2} y={H - 6} textAnchor="middle" className="fill-slate-500" fontSize="11" fontWeight="800">Precio {brandLabel} (S/)</text>
        <text transform={`rotate(-90 14 ${m.top + ih / 2})`} x={14} y={m.top + ih / 2} textAnchor="middle" className="fill-slate-500" fontSize="11" fontWeight="800">Variación vs competidor</text>

        {/* points */}
        {points.map((pt, i) => (
          <circle
            key={i}
            cx={xOf(pt.price)} cy={yOf(pt.pct)} r={4.5}
            fill={pt.color} fillOpacity={0.75} stroke="#fff" strokeWidth={1.2}
            style={{ cursor: 'pointer' }}
            onMouseEnter={e => setTip({
              x: e.clientX, y: e.clientY, color: pt.color,
              lines: [
                pt.name,
                `${brandLabel} S/ ${pt.price.toFixed(2)} · ${pt.compLabel} S/ ${pt.compPrice.toFixed(2)}`,
                `${pt.pct > 0 ? '+' : ''}${pt.pct.toFixed(0)}% (${Math.abs(pt.pct) < 0.5 ? 'similar' : pt.pct > 0 ? `${brandLabel} más caro` : `${brandLabel} más barato`})`,
              ],
            })}
            onMouseLeave={() => setTip(null)}
          />
        ))}
      </svg>

      {tip && (
        <div className="fixed z-50 pointer-events-none max-w-[300px] rounded-lg bg-slate-900 text-white px-3 py-2 shadow-xl"
          style={{ left: Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 320), top: tip.y + 16 }}>
          <p className="text-xs font-bold leading-snug flex items-center gap-1.5"><span className="w-2 h-2 rounded-full inline-block" style={{ background: tip.color }} />{tip.lines[0]}</p>
          {tip.lines.slice(1).map((l, i) => <p key={i} className="text-[11px] text-slate-300 mt-0.5 leading-snug">{l}</p>)}
        </div>
      )}
    </div>
  );
}

type SortState = { key: string; dir: 'asc' | 'desc' };

function Dashboard({ data, competitors, brandLabel }: { data: Comparison; competitors: Competitor[]; brandLabel: string }) {
  const comps = useMemo(
    () => competitors.filter(c => c.hasData !== false),
    [competitors],
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [competitorId, setCompetitorId] = useState('all');
  const [onlyMatched, setOnlyMatched] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: 'ngr', dir: 'asc' });
  // Custom instant tooltip (native `title` is slow). Positioned at the cursor on
  // enter only — no per-move re-render, so the big table stays snappy.
  const [tip, setTip] = useState<{ x: number; y: number; name: string; desc: string } | null>(null);

  const tableComps = useMemo(
    () => (competitorId === 'all' ? comps : comps.filter(c => c.id === competitorId)),
    [comps, competitorId],
  );

  useEffect(() => {
    if (competitorId !== 'all' && !comps.some(c => c.id === competitorId)) {
      setCompetitorId('all');
    }
  }, [comps, competitorId]);
  const showTip = (e: { clientX: number; clientY: number }, name: string, desc: string) =>
    setTip({ x: e.clientX, y: e.clientY, name, desc: desc || '' });
  const hideTip = () => setTip(null);

  const categories = useMemo(
    () => [...new Set(data.rows.map(r => r.ngr.category).filter(Boolean))].sort(),
    [data]
  );

  const valueFor = (row: Row, key: string): string | number | null => {
    if (key === 'ngr') return row.ngr.name.toLowerCase();
    if (key === 'ngrprice') return row.ngr.price ?? null;
    if (key.startsWith('price:')) return row.matches[key.slice(6)]?.best?.price ?? null;
    if (key.startsWith('var:')) return variationPct(row.ngr.price, row.matches[key.slice(4)]?.best?.price ?? null);
    return null;
  };

  const rows = useMemo(() => {
    const q = query.toLowerCase().trim();
    const list = data.rows.filter(r =>
      (!q || r.ngr.name.toLowerCase().includes(q) || (r.ngr.category || '').toLowerCase().includes(q)) &&
      (category === 'all' || r.ngr.category === category) &&
      (!onlyMatched || tableComps.some(c => r.matches[c.id]?.best))
    );
    const mult = sort.dir === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => {
      const va = valueFor(a, sort.key), vb = valueFor(b, sort.key);
      const na = va == null || (typeof va === 'number' && isNaN(va));
      const nb = vb == null || (typeof vb === 'number' && isNaN(vb));
      if (na && nb) return 0;
      if (na) return 1;   // empties always last
      if (nb) return -1;
      if (typeof va === 'string' && typeof vb === 'string') return va < vb ? -mult : va > vb ? mult : 0;
      return ((va as number) - (vb as number)) * mult;
    });
  }, [data, query, category, onlyMatched, sort, tableComps]);

  // Per-competitor KPI: MEAN of per-product % (NGR vs competitor), equal-weighted.
  // +avg = NGR pricier on average; −avg = cheaper. (Distinct from the basket index,
  // which is price-weighted.)
  const compStats = useMemo(() => {
    const out: Record<string, { avgPct: number | null; n: number; index: number | null }> = {};
    for (const c of comps) {
      let sumPct = 0, n = 0, sumNgr = 0, sumComp = 0;
      for (const row of data.rows) {
        const cell = row.matches[c.id];
        if (!isPriceReady(cell)) continue;
        const p = cell!.best!.price;
        if (typeof p === 'number' && row.ngr.price) {
          const pct = variationPct(row.ngr.price, p);
          if (pct == null) continue;
          sumPct += pct;
          sumNgr += row.ngr.price; sumComp += p; n++;
        }
      }
      out[c.id] = { avgPct: n ? sumPct / n : null, n, index: sumComp ? (sumNgr / sumComp) * 100 : null };
    }
    return out;
  }, [data, comps]);

  const toggleSort = (key: string) =>
    setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const arrow = (key: string) =>
    sort.key === key ? (sort.dir === 'asc' ? <ArrowUpIcon className="w-3 h-3" /> : <ArrowDownIcon className="w-3 h-3" />) : null;

  const thBase = 'py-2.5 px-3 text-[10px] font-black uppercase tracking-wider border-b border-slate-200 bg-slate-50/80 cursor-pointer select-none whitespace-nowrap';

  return (
    <div className="space-y-6">
      {/* KPI cards — main metric: average % NGR vs each competitor */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {comps.map(c => {
          const k = data.kpis[c.id];
          const s = compStats[c.id];
          if (!k || !s) return null;
          const avg = s.avgPct;
          const pricier = avg != null && avg > 0.5;
          const cheaper = avg != null && avg < -0.5;
          const cls = avg == null ? 'text-slate-400' : pricier ? 'text-rose-600' : cheaper ? 'text-emerald-600' : 'text-slate-600';
          return (
            <div key={c.id} className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-black text-slate-900">{brandLabel} vs {c.name}</h3>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{s.n} productos</span>
              </div>
              <div className="flex items-end gap-2">
                <span className={`text-4xl font-black tracking-tight ${cls}`}>
                  {avg == null ? '—' : `${avg > 0 ? '+' : ''}${avg.toFixed(0)}%`}
                </span>
              </div>
              <p className="text-[11px] text-slate-500 font-medium mb-1">
                {avg == null ? 'sin datos'
                  : Math.abs(avg) < 0.5 ? `${brandLabel} tiene precios similares en promedio`
                  : `en promedio ${brandLabel} es ${Math.abs(avg).toFixed(0)}% más ${pricier ? 'caro' : 'barato'} que ${c.name}`}
              </p>
              <p className="text-[10px] text-slate-400 mb-4">índice canasta {s.index == null ? '—' : s.index.toFixed(0)} (ponderado por precio)</p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Stat n={k.cheaper} label={`+ barato`} cls="text-emerald-600" />
                <Stat n={k.pricier} label={`+ caro`} cls="text-rose-600" />
                <Stat n={k.pending} label="a revisar" cls="text-amber-600" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Scatter chart */}
      <PriceScatter rows={data.rows} comps={comps} brandLabel={brandLabel} />

      {/* Comparison table */}
      <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em]">Tabla Comparativa</h2>
            <p className="text-[11px] text-slate-400 mt-0.5">
              Precios en S/ · variación = {brandLabel} vs competidor · {rows.length} productos
              {tableComps.length === 1 ? ` · vs ${tableComps[0].name}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <MagnifyingGlassIcon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Filtrar producto…"
                className="pl-9 pr-3 py-2 bg-slate-50 border-0 rounded-lg text-sm w-48 focus:ring-2 focus:ring-slate-200"
              />
            </div>
            <select
              value={competitorId}
              onChange={e => setCompetitorId(e.target.value)}
              aria-label="Filtrar por competidor"
              className="py-2 px-3 bg-slate-50 border-0 rounded-lg text-sm font-medium cursor-pointer focus:ring-2 focus:ring-slate-200 max-w-[200px]"
            >
              <option value="all">Todos los competidores</option>
              {comps.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="py-2 px-3 bg-slate-50 border-0 rounded-lg text-sm font-medium cursor-pointer focus:ring-2 focus:ring-slate-200 max-w-[180px]"
            >
              <option value="all">Todas las categorías</option>
              {categories.map(cat => <option key={cat} value={cat}>{cat}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-xs font-bold text-slate-600 cursor-pointer px-2">
              <input type="checkbox" checked={onlyMatched} onChange={e => setOnlyMatched(e.target.checked)} className="rounded accent-slate-900 w-4 h-4" />
              Solo con match
            </label>
          </div>
        </div>

        <div className="overflow-auto max-h-[600px] custom-scrollbar border border-slate-200 rounded-lg">
          <table className="border-separate border-spacing-0 text-sm w-full min-w-[560px]">
            <thead className="sticky top-0 z-20">
              <tr>
                <th onClick={() => toggleSort('ngr')} className={`${thBase} text-left sticky left-0 z-30 text-slate-700`}>
                  <span className="inline-flex items-center gap-1">{brandLabel}{arrow('ngr')}</span>
                </th>
                <th onClick={() => toggleSort('ngrprice')} className={`${thBase} text-right text-slate-700`}>
                  <span className="inline-flex items-center gap-1 justify-end">Precio{arrow('ngrprice')}</span>
                </th>
                {tableComps.map(c => (
                  <Fragment key={c.id}>
                    <th onClick={() => toggleSort(`price:${c.id}`)} className={`${thBase} text-right text-slate-500 border-l border-slate-200`}>
                      <span className="inline-flex items-center gap-1 justify-end">{c.name}{arrow(`price:${c.id}`)}</span>
                    </th>
                    <th onClick={() => toggleSort(`var:${c.id}`)} className={`${thBase} text-right text-slate-400`}>
                      <span className="inline-flex items-center gap-1 justify-end">Var{arrow(`var:${c.id}`)}</span>
                    </th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={2 + tableComps.length * 2} className="py-12 text-center text-slate-400 italic">Sin resultados para el filtro.</td></tr>
              ) : rows.map((row, i) => (
                <tr key={i} className="group">
                  <td
                    className="py-2 px-3 border-b border-slate-100 font-semibold text-slate-800 sticky left-0 bg-white group-hover:bg-slate-50 z-10 whitespace-nowrap max-w-[280px] truncate cursor-default"
                    onMouseEnter={e => showTip(e, row.ngr.name, row.ngr.description || '')}
                    onMouseLeave={hideTip}
                  >
                    {row.ngr.name}
                  </td>
                  <td className="py-2 px-3 border-b border-slate-100 text-right font-bold text-slate-900 tabular-nums group-hover:bg-slate-50">
                    {typeof row.ngr.price === 'number' ? row.ngr.price.toFixed(2) : '—'}
                  </td>
                  {tableComps.map(c => {
                    const cell = row.matches[c.id];
                    const p = cell?.best?.price;
                    const v = variationPct(row.ngr.price, typeof p === 'number' ? p : null);
                    return (
                      <Fragment key={c.id}>
                        <td
                          className="py-2 px-3 border-b border-slate-100 border-l border-slate-100 text-right tabular-nums text-slate-700 group-hover:bg-slate-50 cursor-default"
                          onMouseEnter={e => cell?.best
                            ? showTip(e, cell.best.name, cell.best.description || '')
                            : showTip(e, cell?.status === 'pending' ? 'Pendiente de revisión' : 'Sin equivalente', '')}
                          onMouseLeave={hideTip}
                        >
                          {typeof p === 'number'
                            ? p.toFixed(2)
                            : <span className="text-slate-300">{cell?.status === 'pending' ? '·' : '—'}</span>}
                        </td>
                        <td className="py-2 px-3 border-b border-slate-100 text-right group-hover:bg-slate-50">
                          <VariationBadge pct={v} />
                        </td>
                      </Fragment>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {tip && (
        <div
          className="fixed z-50 pointer-events-none max-w-[300px] rounded-lg bg-slate-900 text-white px-3 py-2 shadow-xl"
          style={{ left: Math.min(tip.x + 14, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 320), top: tip.y + 16 }}
        >
          <p className="text-xs font-bold leading-snug">{tip.name}</p>
          {tip.desc && <p className="text-[11px] text-slate-300 mt-1 leading-snug">{tip.desc}</p>}
        </div>
      )}
    </div>
  );
}

function Stat({ n, label, cls }: { n: number; label: string; cls: string }) {
  return (
    <div className="bg-slate-50 rounded-lg py-2">
      <p className={`text-lg font-black ${cls}`}>{n}</p>
      <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">{label}</p>
    </div>
  );
}

// ──────────────────────────────────────────────
// Review (manual curation) — table of NGR × competitors
// ──────────────────────────────────────────────
function Review({ data, competitors, onlyPending, setOnlyPending, applyOverride }: {
  data: Comparison;
  competitors: Competitor[];
  onlyPending: boolean;
  setOnlyPending: (v: boolean) => void;
  applyOverride: (ngrName: string, competitorId: string, action: string, product?: Product) => Promise<void> | void;
}) {
  const comps = useMemo(
    () => competitors.filter(c => c.hasData !== false),
    [competitors],
  );

  const rows: Row[] = useMemo(() => {
    const list = data.rows as Row[];
    if (!onlyPending) return list;
    return list.filter(r => Object.values(r.matches).some(c => c.status === 'pending'));
  }, [data, onlyPending]);

  // Preload every competitor catalog once for the dropdowns.
  const [catalogs, setCatalogs] = useState<Record<string, Product[] | null>>({});
  const compIds = comps.map(c => c.id).join('|');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<string, Product[] | null> = {};
      await Promise.all(comps.map(async c => {
        try {
          const r = await axios.get<Product[]>(`${API_BASE}/catalog`, { params: { id: c.id } });
          if (!cancelled) next[c.id] = r.data;
        } catch {
          if (!cancelled) next[c.id] = [];
        }
      }));
      if (!cancelled) setCatalogs(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
  }, [compIds]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm text-slate-500 font-medium">
            {rows.length} productos NGR · elegí el match en cada columna · los cambios se guardan
          </p>
          <div className="flex flex-wrap gap-3 text-[11px] text-slate-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-amber-100 border border-amber-200" aria-hidden />
              Amarillo = revisar
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm bg-rose-100 border border-rose-200" aria-hidden />
              Rojo = sin match
            </span>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm font-bold text-slate-600 cursor-pointer">
          <input
            type="checkbox"
            checked={onlyPending}
            onChange={e => setOnlyPending(e.target.checked)}
            className="rounded accent-slate-900 w-4 h-4"
          />
          Solo pendientes
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-100 py-16 text-center text-slate-400">
          <CheckCircleIcon className="w-10 h-10 text-emerald-300 mx-auto mb-2" />
          No hay productos para mostrar.
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-sm border-collapse min-w-[720px]">
              <thead>
                <tr className="bg-slate-50 text-left">
                  <th className="sticky left-0 z-10 bg-slate-50 py-3 px-4 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-200 min-w-[220px]">
                    Producto NGR
                  </th>
                  <th className="py-3 px-3 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-slate-200 text-right w-24">
                    Precio
                  </th>
                  {comps.map(c => (
                    <th
                      key={c.id}
                      className="py-3 px-3 text-[10px] font-bold uppercase tracking-wider text-slate-400 border-b border-l border-slate-200 min-w-[260px]"
                    >
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={`${row.ngr.name}-${i}`} className="group align-top hover:bg-slate-50/60">
                    <td className="sticky left-0 z-10 bg-white group-hover:bg-slate-50 py-3 px-4 border-b border-slate-100 min-w-[220px]">
                      <p className="font-bold text-slate-900 leading-snug">{row.ngr.name}</p>
                      {row.ngr.category && (
                        <p className="text-[11px] text-slate-400 mt-0.5">{row.ngr.category}</p>
                      )}
                      {row.ngr.description?.trim() && (
                        <p className="text-[11px] text-slate-500 mt-1 leading-snug line-clamp-2" title={row.ngr.description}>
                          {row.ngr.description}
                        </p>
                      )}
                    </td>
                    <td className="py-3 px-3 border-b border-slate-100 text-right font-bold text-slate-900 tabular-nums whitespace-nowrap">
                      {money(row.ngr.price)}
                    </td>
                    {comps.map(c => {
                      const cell = row.matches[c.id];
                      const noMatch = !cell?.best;
                      const needsReview = !noMatch && cell?.status === 'pending';
                      const cellTone = noMatch
                        ? 'bg-rose-50/90'
                        : needsReview
                          ? 'bg-amber-50/90'
                          : '';
                      return (
                        <td
                          key={c.id}
                          className={`py-2 px-3 border-b border-l border-slate-100 ${cellTone}`}
                        >
                          <MatchSelect
                            competitor={c}
                            cell={cell}
                            catalog={catalogs[c.id] ?? null}
                            onChange={(action, product) => applyOverride(row.ngr.name, c.id, action, product)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function MatchSelect({ competitor, cell, catalog, onChange }: {
  competitor: Competitor;
  cell?: Cell;
  catalog: Product[] | null;
  onChange: (action: string, product?: Product) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const current = cell?.best;
  const badge = STATUS_BADGE[!current ? 'rejected' : (cell?.status || 'pending')];

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const filtered = useMemo(() => {
    if (!catalog) return [];
    const q = query.toLowerCase().trim();
    if (!q) return catalog;
    return catalog.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.category || '').toLowerCase().includes(q) ||
      (p.description || '').toLowerCase().includes(q),
    );
  }, [catalog, query]);

  const pick = async (action: string, product?: Product) => {
    setSaving(true);
    try {
      await onChange(action, product);
      setOpen(false);
      setQuery('');
    } finally {
      setSaving(false);
    }
  };

  const currentLabel = current
    ? `${current.name} · ${money(current.price)}`
    : 'Sin equivalente';

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={saving}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Match ${competitor.name}`}
        className={`w-full min-h-[44px] text-left rounded-lg border px-2.5 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-400 cursor-pointer disabled:opacity-50 active:scale-[0.99] transition-transform ${
          !current
            ? 'border-rose-200 bg-rose-50/50 hover:border-rose-300'
            : cell?.status === 'pending'
              ? 'border-amber-200 bg-amber-50/40 hover:border-amber-300'
              : 'border-slate-200 bg-white hover:border-slate-300'
        }`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className={`text-sm leading-snug line-clamp-2 ${current ? 'font-semibold text-slate-800' : 'italic text-slate-500'}`}>
              {current ? current.name : 'Sin equivalente'}
            </p>
            <div className="flex flex-wrap items-center gap-1.5 mt-1">
              {current && (
                <span className="text-xs font-bold text-slate-900 tabular-nums">{money(current.price)}</span>
              )}
              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${badge.cls}`}>
                {badge.label}{cell?.edited ? ' ✎' : ''}
              </span>
              {typeof current?.score === 'number' && !cell?.edited && (
                <span className="text-[10px] text-slate-400 font-bold">{current.score}</span>
              )}
            </div>
            {current?.description?.trim() ? (
              <p className="text-[11px] text-slate-500 mt-1.5 leading-snug line-clamp-3" title={current.description}>
                {current.description}
              </p>
            ) : current ? (
              <p className="text-[11px] text-slate-400 mt-1.5 italic">Sin descripción</p>
            ) : null}
          </div>
          <span className="text-slate-400 text-xs shrink-0 mt-0.5" aria-hidden>▾</span>
        </div>
      </button>

      {open && (
        <div className="absolute z-30 left-0 right-0 mt-1 rounded-xl border border-slate-200 bg-white shadow-sm overflow-hidden min-w-[280px]">
          <div className="relative border-b border-slate-100">
            <MagnifyingGlassIcon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              autoFocus
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={`Buscar en ${competitor.name}…`}
              className="w-full pl-9 pr-3 py-2.5 text-sm bg-white focus:outline-none"
            />
          </div>
          <div className="max-h-64 overflow-y-auto custom-scrollbar" role="listbox" aria-label={currentLabel}>
            {current && cell?.status === 'pending' && (
              <button
                type="button"
                role="option"
                onClick={() => pick('confirm')}
                className="w-full text-left px-3 py-2.5 text-sm text-emerald-700 font-semibold hover:bg-emerald-50 cursor-pointer border-b border-slate-50"
              >
                Confirmar sugerencia
              </button>
            )}
            <button
              type="button"
              role="option"
              onClick={() => pick('reject')}
              className="w-full text-left px-3 py-2.5 text-sm text-rose-600 hover:bg-rose-50 cursor-pointer border-b border-slate-50"
            >
              Sin equivalente
            </button>
            {cell?.edited && (
              <button
                type="button"
                role="option"
                onClick={() => pick('reset')}
                className="w-full text-left px-3 py-2.5 text-sm text-slate-500 hover:bg-slate-50 cursor-pointer border-b border-slate-50"
              >
                Restaurar sugerencia IA
              </button>
            )}
            {catalog === null ? (
              <p className="px-3 py-3 text-xs text-slate-400 italic">Cargando catálogo…</p>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-slate-400 italic">Sin resultados</p>
            ) : filtered.map((p, j) => {
              const selected = current?.name === p.name;
              return (
                <button
                  key={`${p.name}-${j}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => pick('reassign', p)}
                  className={`w-full text-left px-3 py-2 hover:bg-slate-50 cursor-pointer border-b border-slate-50 last:border-0 ${selected ? 'bg-slate-50' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className={`text-sm leading-snug ${selected ? 'font-bold text-slate-900' : 'text-slate-700'}`}>
                      {p.name}
                    </span>
                    <span className="text-xs font-bold text-slate-900 tabular-nums shrink-0">{money(p.price)}</span>
                  </div>
                  {p.description?.trim() && (
                    <p className="text-[11px] text-slate-400 mt-0.5 leading-snug line-clamp-2">{p.description}</p>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
