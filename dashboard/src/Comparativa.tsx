import { useState, useEffect, useMemo } from 'react';
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
        <Dashboard data={data} competitors={competitors} />
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
function Dashboard({ data, competitors }: { data: Comparison; competitors: Competitor[] }) {
  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {competitors.filter(c => c.hasData !== false).map(c => {
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
                {idx == null ? 'sin datos' : idx > 100 ? `NGR es ${(idx - 100).toFixed(0)}% más caro en promedio` : `NGR es ${(100 - idx).toFixed(0)}% más barato en promedio`}
              </p>
              <div className="grid grid-cols-3 gap-2 text-center">
                <Stat n={k.pricier} label="más caro" cls="text-rose-600" />
                <Stat n={k.cheaper} label="más barato" cls="text-emerald-600" />
                <Stat n={k.pending} label="a revisar" cls="text-amber-600" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Comparison table */}
      <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm overflow-hidden">
        <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em] mb-4">Tabla Comparativa</h2>
        <div className="overflow-auto max-h-[560px] custom-scrollbar">
          <table className="w-full text-left border-separate border-spacing-0 min-w-[720px]">
            <thead className="sticky top-0 bg-white z-10">
              <tr>
                <th className="py-3 pr-4 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">Producto NGR</th>
                {competitors.filter(c => c.hasData !== false).map(c => (
                  <th key={c.id} className="py-3 px-4 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">{c.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, i) => (
                <tr key={i} className="hover:bg-slate-50/50 transition-colors align-top">
                  <td className="py-3 pr-4 border-b border-slate-50 max-w-[240px]">
                    <p className="font-bold text-slate-900 leading-tight">{row.ngr.name}</p>
                    <p className="text-[13px] font-black text-slate-900 mt-0.5">{money(row.ngr.price)}</p>
                  </td>
                  {competitors.filter(c => c.hasData !== false).map(c => {
                    const cell = row.matches[c.id];
                    return (
                      <td key={c.id} className="py-3 px-4 border-b border-slate-50 max-w-[240px]">
                        {cell?.best ? (
                          <>
                            <p className="text-sm text-slate-700 leading-tight line-clamp-2" title={cell.best.name}>{cell.best.name}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-[13px] font-bold text-slate-900">{money(cell.best.price)}</span>
                              <DeltaBadge delta={cell.delta} deltaPct={cell.deltaPct} />
                            </div>
                          </>
                        ) : (
                          <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${cell?.status === 'pending' ? 'bg-amber-50 text-amber-600' : 'bg-slate-50 text-slate-400'}`}>
                            {cell?.status === 'pending' ? 'a revisar' : 'sin equivalente'}
                          </span>
                        )}
                      </td>
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
