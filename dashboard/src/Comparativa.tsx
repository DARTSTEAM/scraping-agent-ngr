import { useState, useEffect, useMemo, Fragment } from 'react';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowsRightLeftIcon,
  MagnifyingGlassIcon,
  ExclamationTriangleIcon,
  SparklesIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  MinusIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';

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

function DeltaBadge({ delta, deltaPct }: { delta: number | null; deltaPct: number | null }) {
  if (delta === null || deltaPct === null) return <span className="text-slate-300">—</span>;
  const pricier = delta > 0.05;
  const cheaper = delta < -0.05;
  const cls = pricier ? 'text-rose-600 bg-rose-50' : cheaper ? 'text-emerald-600 bg-emerald-50' : 'text-slate-500 bg-slate-50';
  const Icon = pricier ? ArrowUpIcon : cheaper ? ArrowDownIcon : MinusIcon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-bold ${cls}`} title="NGR vs competidor">
      <Icon className="w-3 h-3" />
      {deltaPct > 0 ? '+' : ''}{deltaPct.toFixed(0)}%
    </span>
  );
}

export default function Comparativa() {
  const [brands, setBrands] = useState<BrandInfo[]>([]);
  const [brand, setBrand] = useState('');
  const [channel, setChannel] = useState<'rappi' | 'propio'>('rappi');
  const [data, setData] = useState<Comparison | null>(null);
  const [subTab, setSubTab] = useState<'dashboard' | 'review'>('dashboard');
  const [loading, setLoading] = useState(false);
  const [recalculating, setRecalculating] = useState(false);
  const [error, setError] = useState('');
  const [onlyPending, setOnlyPending] = useState(true);

  useEffect(() => {
    axios.get<BrandInfo[]>(`${API_BASE}/brands`).then(r => {
      setBrands(r.data);
      if (r.data.length && !brand) setBrand(r.data[0].key);
    }).catch(() => setError('No se pudo cargar la lista de marcas.'));
  }, []);

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
        <div className="flex items-center gap-3">
          {data?.generatedAt && (
            <span className="text-[11px] text-slate-400 font-medium hidden md:block">
              Último cálculo: {new Date(data.generatedAt).toLocaleString('es-PE')}
            </span>
          )}
          <button
            onClick={recalcular}
            disabled={recalculating}
            className="px-5 py-2.5 bg-slate-900 text-white rounded-xl hover:bg-slate-800 shadow-lg shadow-slate-200 transition-all flex items-center gap-2 font-semibold disabled:opacity-50 cursor-pointer"
          >
            <SparklesIcon className={`w-5 h-5 ${recalculating ? 'animate-pulse' : ''}`} />
            {recalculating ? 'Cruzando con IA…' : 'Recalcular matches'}
          </button>
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
        <EmptyState brandLabel={currentBrand?.label} channel={channel} onRecalc={recalcular} recalculating={recalculating} />
      ) : subTab === 'dashboard' ? (
        <Dashboard data={data} competitors={competitors} brandLabel={currentBrand?.label || data.brand} />
      ) : (
        <Review data={data} competitors={competitors} onlyPending={onlyPending} setOnlyPending={setOnlyPending}
                brand={brand} channel={channel} applyOverride={applyOverride} />
      )}
    </div>
  );
}

function totalPending(data: Comparison) {
  return data.rows.reduce((acc, row) =>
    acc + Object.values(row.matches).filter(c => c.status === 'pending').length, 0);
}

function EmptyState({ brandLabel, channel, onRecalc, recalculating }: any) {
  return (
    <div className="bg-white rounded-2xl border border-dashed border-slate-200 py-20 text-center space-y-4">
      <SparklesIcon className="w-12 h-12 text-slate-200 mx-auto" />
      <div>
        <p className="text-slate-600 font-bold">Todavía no hay cruce para {brandLabel} en {CHANNEL_LABEL[channel]}</p>
        <p className="text-slate-400 text-sm mt-1">Ejecutá el matching con IA para generar la comparativa de precios.</p>
      </div>
      <button
        onClick={onRecalc}
        disabled={recalculating}
        className="px-5 py-2.5 bg-slate-900 text-white rounded-xl hover:bg-slate-800 transition-all inline-flex items-center gap-2 font-semibold disabled:opacity-50 cursor-pointer"
      >
        <SparklesIcon className={`w-5 h-5 ${recalculating ? 'animate-pulse' : ''}`} />
        {recalculating ? 'Cruzando con IA…' : 'Recalcular matches'}
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────
// Dashboard
// ──────────────────────────────────────────────
// Variation of a competitor price RELATIVE TO the NGR price.
// +% (competitor more expensive → NGR cheaper) is good for NGR → green up.
// -% (competitor cheaper) → red down.
function variationPct(ngrPrice: number | undefined, compPrice: number | null | undefined): number | null {
  if (!ngrPrice || typeof compPrice !== 'number') return null;
  return ((compPrice - ngrPrice) / ngrPrice) * 100;
}

function VariationBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-slate-300">—</span>;
  const up = pct > 0.05, down = pct < -0.05;
  const cls = up ? 'text-emerald-600' : down ? 'text-rose-600' : 'text-slate-400';
  const Icon = up ? ArrowUpIcon : down ? ArrowDownIcon : MinusIcon;
  return (
    <span className={`inline-flex items-center justify-end gap-0.5 font-bold tabular-nums ${cls}`}>
      <Icon className="w-3.5 h-3.5" />{Math.abs(pct).toFixed(0)}%
    </span>
  );
}

type SortState = { key: string; dir: 'asc' | 'desc' };

function Dashboard({ data, competitors, brandLabel }: { data: Comparison; competitors: Competitor[]; brandLabel: string }) {
  const comps = competitors.filter(c => c.hasData !== false);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [onlyMatched, setOnlyMatched] = useState(false);
  const [sort, setSort] = useState<SortState>({ key: 'ngr', dir: 'asc' });

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
      (!onlyMatched || comps.some(c => r.matches[c.id]?.best))
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
  }, [data, query, category, onlyMatched, sort, comps]);

  const toggleSort = (key: string) =>
    setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  const arrow = (key: string) =>
    sort.key === key ? (sort.dir === 'asc' ? <ArrowUpIcon className="w-3 h-3" /> : <ArrowDownIcon className="w-3 h-3" />) : null;

  const thBase = 'py-2.5 px-3 text-[10px] font-black uppercase tracking-wider border-b border-slate-200 bg-slate-50/80 cursor-pointer select-none whitespace-nowrap';

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {comps.map(c => {
          const k = data.kpis[c.id];
          if (!k) return null;
          const idx = k.priceIndex;
          const idxCls = idx == null ? 'text-slate-400' : idx > 101 ? 'text-rose-600' : idx < 99 ? 'text-emerald-600' : 'text-slate-600';
          return (
            <div key={c.id} className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-black text-slate-900">{c.name}</h3>
                <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{k.matched} matches</span>
              </div>
              <div className="flex items-end gap-2">
                <span className={`text-4xl font-black tracking-tight ${idxCls}`}>{idx == null ? '—' : idx.toFixed(0)}</span>
                <span className="text-slate-400 text-sm font-bold mb-1.5">índice precio</span>
              </div>
              <p className="text-[11px] text-slate-400 mb-4">
                {idx == null ? 'sin datos' : idx > 100 ? `${brandLabel} es ${(idx - 100).toFixed(0)}% más caro en promedio` : `${brandLabel} es ${(100 - idx).toFixed(0)}% más barato en promedio`}
              </p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Stat n={k.cheaper} label="+ barato NGR" cls="text-emerald-600" />
                <Stat n={k.pricier} label="+ caro NGR" cls="text-rose-600" />
                <Stat n={k.pending} label="a revisar" cls="text-amber-600" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Comparison table */}
      <div className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-4">
          <div>
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em]">Tabla Comparativa</h2>
            <p className="text-[11px] text-slate-400 mt-0.5">Precios en S/ · variación = competidor vs {brandLabel} · {rows.length} productos</p>
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
                {comps.map(c => (
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
                <tr><td colSpan={2 + comps.length * 2} className="py-12 text-center text-slate-400 italic">Sin resultados para el filtro.</td></tr>
              ) : rows.map((row, i) => (
                <tr key={i} className="group">
                  <td
                    className="py-2 px-3 border-b border-slate-100 font-semibold text-slate-800 sticky left-0 bg-white group-hover:bg-slate-50 z-10 whitespace-nowrap max-w-[280px] truncate cursor-default"
                    title={row.ngr.description || row.ngr.name}
                  >
                    {row.ngr.name}
                  </td>
                  <td className="py-2 px-3 border-b border-slate-100 text-right font-bold text-slate-900 tabular-nums group-hover:bg-slate-50">
                    {typeof row.ngr.price === 'number' ? row.ngr.price.toFixed(2) : '—'}
                  </td>
                  {comps.map(c => {
                    const cell = row.matches[c.id];
                    const p = cell?.best?.price;
                    const v = variationPct(row.ngr.price, typeof p === 'number' ? p : null);
                    return (
                      <Fragment key={c.id}>
                        <td
                          className="py-2 px-3 border-b border-slate-100 border-l border-slate-100 text-right tabular-nums text-slate-700 group-hover:bg-slate-50 cursor-default"
                          title={cell?.best?.name || (cell?.status === 'pending' ? 'Pendiente de revisión' : 'Sin equivalente')}
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
// Review (manual curation)
// ──────────────────────────────────────────────
function Review({ data, competitors, onlyPending, setOnlyPending, applyOverride }: any) {
  const rows: Row[] = useMemo(() => {
    const list = data.rows as Row[];
    if (!onlyPending) return list;
    return list.filter(r => Object.values(r.matches).some(c => c.status === 'pending'));
  }, [data, onlyPending]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500 font-medium">{rows.length} productos NGR · umbral de confianza {data.reviewThreshold}</p>
        <label className="flex items-center gap-2 text-sm font-bold text-slate-600 cursor-pointer">
          <input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)} className="rounded accent-slate-900 w-4 h-4" />
          Solo pendientes
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-100 py-16 text-center text-slate-400">
          <CheckCircleIcon className="w-10 h-10 text-emerald-300 mx-auto mb-2" />
          No hay matches pendientes de revisión. 🎉
        </div>
      ) : rows.map((row, i) => (
        <div key={i} className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm">
          <div className="flex items-baseline gap-3 mb-4">
            <p className="font-black text-slate-900">{row.ngr.name}</p>
            <span className="text-sm font-bold text-slate-500">{money(row.ngr.price)}</span>
            <span className="text-[11px] text-slate-400">{row.ngr.category}</span>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {competitors.filter((c: Competitor) => c.hasData !== false).map((c: Competitor) => (
              <MatchEditor
                key={c.id}
                competitor={c}
                cell={row.matches[c.id]}
                onAction={(action, product) => applyOverride(row.ngr.name, c.id, action, product)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MatchEditor({ competitor, cell, onAction }: { competitor: Competitor; cell: Cell; onAction: (a: string, p?: Product) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [catalog, setCatalog] = useState<Product[] | null>(null);
  const badge = STATUS_BADGE[cell.status];

  const openReassign = async () => {
    setExpanded(!expanded);
    if (!catalog) {
      try {
        const r = await axios.get<Product[]>(`${API_BASE}/catalog`, { params: { id: competitor.id } });
        setCatalog(r.data);
      } catch { setCatalog([]); }
    }
  };

  const searchResults = useMemo(() => {
    if (!catalog) return [];
    const q = query.toLowerCase().trim();
    const base = q ? catalog.filter(p => p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)) : catalog;
    return base.slice(0, 30);
  }, [catalog, query]);

  return (
    <div className="border border-slate-100 rounded-xl p-4 bg-slate-50/40">
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-black text-slate-500 uppercase tracking-wider">{competitor.name}</span>
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${badge.cls}`}>{badge.label}{cell.edited ? ' ✎' : ''}</span>
      </div>

      {cell.best ? (
        <div className="mb-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-bold text-slate-800 leading-tight">{cell.best.name}</p>
            <span className="text-sm font-black text-slate-900 shrink-0">{money(cell.best.price)}</span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <DeltaBadge delta={cell.delta} deltaPct={cell.deltaPct} />
            <span className="text-[10px] text-slate-400 font-bold">confianza {cell.best.score}</span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-400 italic mb-3">Sin equivalente asignado</p>
      )}

      <div className="flex flex-wrap gap-2">
        {cell.best && cell.status !== 'confirmed' && (
          <button onClick={() => onAction('confirm')} className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-emerald-50 text-emerald-700 rounded-lg text-xs font-bold hover:bg-emerald-100 cursor-pointer">
            <CheckCircleIcon className="w-4 h-4" /> Confirmar
          </button>
        )}
        {cell.status !== 'rejected' && (
          <button onClick={() => onAction('reject')} className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-rose-50 text-rose-600 rounded-lg text-xs font-bold hover:bg-rose-100 cursor-pointer">
            <XCircleIcon className="w-4 h-4" /> Rechazar
          </button>
        )}
        <button onClick={openReassign} className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-bold hover:bg-slate-200 cursor-pointer">
          <ArrowsRightLeftIcon className="w-4 h-4" /> Reasignar
        </button>
        {cell.edited && (
          <button onClick={() => onAction('reset')} className="inline-flex items-center gap-1 px-2.5 py-1.5 text-slate-400 rounded-lg text-xs font-bold hover:text-slate-600 cursor-pointer">
            <ArrowPathIcon className="w-4 h-4" /> Deshacer
          </button>
        )}
      </div>

      {expanded && (
        <div className="mt-3 border-t border-slate-100 pt-3 space-y-2">
          {cell.alternatives.length > 0 && (
            <div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-wider mb-1">Alternativas sugeridas</p>
              {cell.alternatives.map((alt, j) => (
                <AltRow key={j} p={alt} onPick={() => { onAction('reassign', alt); setExpanded(false); }} score={alt.score} />
              ))}
            </div>
          )}
          <div>
            <div className="relative">
              <MagnifyingGlassIcon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={`Buscar cualquier producto de ${competitor.name}…`}
                className="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-slate-100"
              />
            </div>
            <div className="max-h-48 overflow-auto mt-2 custom-scrollbar">
              {catalog === null ? (
                <p className="text-xs text-slate-400 italic py-2">Cargando catálogo…</p>
              ) : searchResults.map((p, j) => (
                <AltRow key={j} p={p} onPick={() => { onAction('reassign', p); setExpanded(false); }} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AltRow({ p, onPick, score }: { p: Product; onPick: () => void; score?: number }) {
  return (
    <button onClick={onPick} className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-white text-left cursor-pointer group">
      <span className="text-sm text-slate-700 group-hover:text-slate-900 leading-tight line-clamp-1">{p.name}</span>
      <span className="flex items-center gap-2 shrink-0">
        {typeof score === 'number' && <span className="text-[10px] text-slate-400 font-bold">{score}</span>}
        <span className="text-sm font-bold text-slate-900">{money(p.price)}</span>
      </span>
    </button>
  );
}
