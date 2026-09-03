import { useState, useEffect } from 'react';
import {
  ArrowPathIcon,
  ArrowDownTrayIcon,
  ShoppingBagIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  ClockIcon,
  BuildingOfficeIcon,
  GlobeAltIcon
} from '@heroicons/react/24/outline';
import axios from 'axios';
import logoNgr from './assets/Logo-ngr.png';
import Comparativa from './Comparativa';
import { formatPeruDateTime } from './formatDate';

// In production the frontend is served by the same Express server,
// so relative paths work. In dev, Vite proxies /api to localhost:3001.
const API_BASE = '/api';

// NGR locals and their Rappi competitors
const NGR_GROUPS = [
  {
    ngrLocal: 'Bembos',
    competitors: [
      { name: "McDonald's",  url: "https://www.rappi.com.pe/restaurantes/742-mcdonalds",     id: '742',   platform: 'Rappi' },
      { name: "Burger King", url: "https://www.rappi.com.pe/restaurantes/2376-burger-king",  id: '2376',  platform: 'Rappi' },
    ]
  },
  {
    ngrLocal: 'Popeyes',
    competitors: [
      { name: "KFC",   url: "https://www.rappi.com.pe/restaurantes/6337-kfc",   id: '6337',  platform: 'Rappi' },
      { name: "Yopo",  url: "https://www.rappi.com.pe/restaurantes/58629-yopo",  id: '58629', platform: 'Rappi' },
    ]
  },
  {
    ngrLocal: 'Papa Johns',
    competitors: [
      { name: "Pizza Hut",      url: "https://www.rappi.com.pe/restaurantes/2372-pizza-hut",      id: '2372',  platform: 'Rappi' },
      { name: "Domino's Pizza", url: "https://www.rappi.com.pe/restaurantes/74738-dominos-pizza", id: '74738', platform: 'Rappi' },
      { name: "Little Caesars", url: "https://www.rappi.com.pe/restaurantes/4136-little-caesars", id: '4136',  platform: 'Rappi' },
    ]
  },
  {
    ngrLocal: 'Chinawok',
    competitors: [
      { name: "Wanta Chifa",  url: "https://www.rappi.com.pe/restaurantes/73245-wanta-chifa",            id: '73245', platform: 'Rappi' },
      { name: "Chifa Express", url: "https://www.rappi.com.pe/restaurantes/13399-chifa-express-chifa",  id: '13399', platform: 'Rappi' },
    ]
  },
  {
    ngrLocal: 'Dunkin',
    competitors: [
      { name: "Starbucks",   url: "https://www.rappi.com.pe/restaurantes/38002-starbucks",  id: '38002', platform: 'Rappi' },
      { name: "Juan Valdez", url: "https://www.rappi.com.pe/restaurantes/79108-juan-valdez", id: '79108', platform: 'Rappi' },
      { name: "Cinnabon",    url: "https://www.rappi.com.pe/restaurantes/66914-cinnabon",    id: '66914', platform: 'Rappi' },
    ]
  },
  {
    ngrLocal: 'Don Belisario',
    competitors: [
      { name: "Pardos Chicken", url: "https://www.rappi.com.pe/restaurantes/4580-pardos-chicken", id: '4580', platform: 'Rappi' },
      { name: "Rokys",         url: "https://www.rappi.com.pe/restaurantes/5341-rokys",          id: '5341', platform: 'Rappi' },
    ]
  },
];

// NGR own brands on Rappi
const NGR_OWN_RAPPI = [
  { name: "Bembos",        url: "https://www.rappi.com.pe/restaurantes/1109-bembos",          id: '1109',  platform: 'Rappi' },
  { name: "Popeyes",       url: "https://www.rappi.com.pe/restaurantes/95275-popeyes",        id: '95275', platform: 'Rappi' },
  { name: "Dunkin'",       url: "https://www.rappi.com.pe/restaurantes/61955-dunkin",          id: '61955', platform: 'Rappi' },
  { name: "Papa Johns",    url: "https://www.rappi.com.pe/restaurantes/1121-papa-johns",      id: '1121',  platform: 'Rappi' },
  { name: "Don Belisario", url: "https://www.rappi.com.pe/restaurantes/1190-don-belisario",    id: '1190',  platform: 'Rappi' },
  { name: "Chinawok",      url: "https://www.rappi.com.pe/restaurantes/10266-chinawok-chifa",  id: '10266', platform: 'Rappi' },
];

// PedidosYa — same brand set (Miraflores / Óvalo Gutiérrez area)
const NGR_OWN_PEYA = [
  { name: "Bembos",        url: "https://www.pedidosya.com.pe/restaurantes/lima/bembos-ovalo-gutierrez-menu", id: 'peya-bembos', platform: 'PedidosYa' },
  { name: "Popeyes",       url: "https://www.pedidosya.com.pe/restaurantes/lima/popeyes-larco-menu", id: 'peya-popeyes', platform: 'PedidosYa' },
  { name: "Dunkin'",       url: "https://www.pedidosya.com.pe/restaurantes/lima/dunkin-donuts--plaza-vea-dasso-94678500-43d1-416f-952b-3324db81f862-menu", id: 'peya-dunkin', platform: 'PedidosYa' },
  { name: "Papa Johns",    url: "https://www.pedidosya.com.pe/restaurantes/lima/papa-johns-comandante-espinar-menu", id: 'peya-papajohns', platform: 'PedidosYa' },
  { name: "Don Belisario", url: "https://www.pedidosya.com.pe/restaurantes/lima/don-belisario-larco-93da4fb3-c49b-4607-ae33-4733f1343acc-menu", id: 'peya-donbelisario', platform: 'PedidosYa' },
  { name: "Chinawok",      url: "https://www.pedidosya.com.pe/restaurantes/lima/chinawok-patio-larco-menu", id: 'peya-chinawok', platform: 'PedidosYa' },
];

const NGR_GROUPS_PEYA = [
  {
    ngrLocal: 'Bembos',
    competitors: [
      { name: "McDonald's",  url: "https://www.pedidosya.com.pe/restaurantes/lima/mcdonalds-ovalo-gutierrez-e6b6652e-45c6-44f7-8976-e376edf475a8-menu", id: 'peya-mcdonalds', platform: 'PedidosYa' },
      { name: "Burger King", url: "https://www.pedidosya.com.pe/restaurantes/lima/burger-king-cavenecia-menu", id: 'peya-burgerking', platform: 'PedidosYa' },
    ]
  },
  {
    ngrLocal: 'Popeyes',
    competitors: [
      { name: "KFC",  url: "https://www.pedidosya.com.pe/restaurantes/lima/kfc-cavenecia-b16e2057-319a-4649-8b55-e0a9f2819f25-menu", id: 'peya-kfc', platform: 'PedidosYa' },
      { name: "Yopo", url: "https://www.pedidosya.com.pe/restaurantes/lima/yopo--comandante-espinar-dd561e26-1e20-4821-8de0-0600196ca88f-menu", id: 'peya-yopo', platform: 'PedidosYa' },
    ]
  },
  {
    ngrLocal: 'Papa Johns',
    competitors: [
      { name: "Pizza Hut",      url: "https://www.pedidosya.com.pe/restaurantes/lima/pizza-hut-espinar-menu", id: 'peya-pizzahut', platform: 'PedidosYa' },
      // Domino's: no local encontrado cerca de Óvalo Gutiérrez aún
      { name: "Little Caesars", url: "https://www.pedidosya.com.pe/restaurantes/lima/little-caesars-pizza-miraflores-menu", id: 'peya-littlecaesars', platform: 'PedidosYa' },
    ]
  },
  {
    ngrLocal: 'Chinawok',
    competitors: [
      { name: "Wanta Chifa",   url: "https://www.pedidosya.com.pe/restaurantes/lima/wanta-chifa-santa-cruz-add0b531-7c31-4784-9248-c5ad98760f27-menu", id: 'peya-wanta', platform: 'PedidosYa' },
      { name: "Chifa Express", url: "https://www.pedidosya.com.pe/restaurantes/lima/chifa-express-6-menu", id: 'peya-chifaexpress', platform: 'PedidosYa' },
    ]
  },
  {
    ngrLocal: 'Dunkin',
    competitors: [
      { name: "Starbucks",   url: "https://www.pedidosya.com.pe/restaurantes/lima/starbucks-dasso-1d98eee0-22b6-4f5d-bc6f-5bab57b685d3-menu", id: 'peya-starbucks', platform: 'PedidosYa' },
      { name: "Juan Valdez", url: "https://www.pedidosya.com.pe/restaurantes/lima/juan-valdez--pardo-e98f160c-e5d8-4391-8697-db1976868a4c-menu", id: 'peya-juanvaldez', platform: 'PedidosYa' },
      { name: "Cinnabon",    url: "https://www.pedidosya.com.pe/restaurantes/lima/cinnabon--larcomar-ce7504bd-203c-40d6-baca-da72f1c94b2c-menu", id: 'peya-cinnabon', platform: 'PedidosYa' },
    ]
  },
  {
    ngrLocal: 'Don Belisario',
    competitors: [
      { name: "Pardos Chicken", url: "https://www.pedidosya.com.pe/restaurantes/lima/pardos-chicken-santa-cruz-menu", id: 'peya-pardos', platform: 'PedidosYa' },
      { name: "Rokys",         url: "https://www.pedidosya.com.pe/restaurantes/lima/rokys-angamos-este-menu", id: 'peya-rokys', platform: 'PedidosYa' },
    ]
  },
];

// NGR own brands and their own-site menus, grouped by brand
const NGR_OWN_GROUPS = [
  {
    ngrLocal: 'Bembos',
    stores: [
      { name: "Bembos",                 url: "https://www.bembos.com.pe/menu",                                                  id: 'bembos-pe',           platform: 'Propio' },
      { name: "McDonald's (Benavides)", url: "https://www.mcdonalds.com.pe/restaurantes/lima/benavides-aurora-bau/pedidos", id: 'mcd-benavides-aurora-bau', platform: 'Propio' },
      { name: "Burger King",            url: "https://www.burgerking.pe/carta",                                                  id: 'burgerking-pe',       platform: 'Propio' },
    ]
  },
  {
    ngrLocal: 'Popeyes',
    stores: [
      { name: "Popeyes",url: "https://www.popeyes.com.pe/menu",           id: 'popeyes-pe', platform: 'Propio' },
      { name: "KFC",     url: "https://www.kfc.com.pe/carta",              id: 'kfc-pe',     platform: 'Propio' },
      { name: "Yopo",    url: "https://yopo.pe/categorias/",               id: 'yopo-pe',    platform: 'Propio' },
    ]
  },
  {
    ngrLocal: 'Papa Johns',
    stores: [
      { name: "Papa Johns",             url: "https://www.papajohns.com.pe/menu",            id: 'papajohns-pe',        platform: 'Propio' },
      { name: "Pizza Hut (Miraflores)", url: "https://www.pizzahut.com.pe/carta",             id: 'pizzahut-miraflores', platform: 'Propio' },
      { name: "Little Caesars",         url: "https://pe.littlecaesars.com/es-pe/menu/",     id: 'littlecaesars-pe',    platform: 'Propio' },
    ]
  },
  {
    ngrLocal: 'Chinawok',
    stores: [
      { name: "Chinawok",     url: "https://www.chinawok.com.pe/menu",       id: 'chinawok-pe',    platform: 'Propio' },
      { name: "Wanta",        url: "https://www.wanta.pe/carta",             id: 'wanta-pe',       platform: 'Propio' },
      { name: "Chifa Express",url: "https://www.chifaexpress.pe/pedir",      id: 'chifaexpress-pe',platform: 'Propio' },
    ]
  },
  {
    ngrLocal: 'Dunkin',
    stores: [
      { name: "Dunkin'",     url: "https://www.dunkin.pe/menu",              id: 'dunkin-pe',    platform: 'Propio' },
      { name: "Starbucks",   url: "https://www.starbucks.pe/menu",           id: 'starbucks-pe', platform: 'Propio' },
      { name: "Cinnabon",    url: "https://www.cinnabon.com.pe/pedir",       id: 'cinnabon-pe',  platform: 'Propio' },
    ]
  },
  {
    ngrLocal: 'Don Belisario',
    stores: [
      { name: "Don Belisario",url: "https://www.donbelisario.com.pe/menu",   id: 'donbelisario-pe', platform: 'Propio' },
      { name: "Rokys",        url: "https://rokys.com/menu",                  id: 'rokys-pe',        platform: 'Propio' },
    ]
  },
];

// Flat list for lookups / scraper dispatch
const COMPETITORS = [
  ...NGR_OWN_RAPPI,
  ...NGR_GROUPS.flatMap(g => g.competitors),
  ...NGR_OWN_PEYA,
  ...NGR_GROUPS_PEYA.flatMap(g => g.competitors),
  ...NGR_OWN_GROUPS.flatMap(g => g.stores),
];

interface Product {
  restaurant: string;
  category: string;
  name: string;
  description: string;
  price: number;
}

interface CompetitorData {
  id: string;
  name: string;
  platform: string;
  local: string;
  lastUpdated: string;
  products: Product[];
  csvFile: string;
}

export default function App() {
  const [data, setData] = useState<CompetitorData[]>([]);
  const [selectedCompId, setSelectedCompId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'competitors' | 'own' | 'comparativa'>('competitors');
  const [aggregator, setAggregator] = useState<'Rappi' | 'PedidosYa'>('Rappi');

  const fetchData = async () => {
    setLoading(true);
    try {
      const resp = await axios.get(`${API_BASE}/results`);
      setData(resp.data);
      if (resp.data.length > 0 && !selectedCompId) {
        setSelectedCompId(resp.data[0].id);
      }
    } catch (err) {
      console.error('Error fetching data:', err);
    } finally {
      setLoading(false);
    }
  };

  const filteredCompetitors = COMPETITORS.filter(c =>
    activeTab === 'competitors'
      ? c.platform === aggregator
      : c.platform === 'Propio'
  );

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (filteredCompetitors.length > 0 && !filteredCompetitors.find(c => c.id === selectedCompId)) {
      setSelectedCompId(filteredCompetitors[0].id);
    }
  }, [activeTab, aggregator, data]);

  const handleUpdate = async () => {
    const comp = COMPETITORS.find(c => c.id === selectedCompId) || { url: `https://www.rappi.com.pe/restaurantes/${selectedCompId}` };
    setUpdating(true);
    try {
      await axios.post(`${API_BASE}/update`, { url: comp.url });
      await fetchData();
    } catch (err: any) {
      console.error('Error updating:', err);
      const msg = err.response?.data?.error || 'Error al actualizar.';
      alert(msg);
    } finally {
      setUpdating(false);
    }
  };

  const handleDownload = async () => {
    const currentComp = data.find(d => d.id === selectedCompId);
    if (!currentComp) return;

    window.open(`${API_BASE}/download/${currentComp.csvFile}`);
  };

  const currentCompData = data.find(d => d.id === selectedCompId);

  const filteredProducts = (currentCompData?.products || []).filter(p =>
    p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    p.category.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-[#F9FAFB] p-6 lg:p-10 font-sans">
      <div className="max-w-7xl mx-auto space-y-8">

        {/* Header */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="w-16 h-16 bg-white rounded-2xl shadow-sm border border-slate-100 flex items-center justify-center overflow-hidden p-2">
              <img src={logoNgr} alt="NGR Logo" className="w-full h-auto object-contain" />
            </div>
            <div>
              <h1 className="text-3xl font-extrabold text-slate-900 tracking-tight">Scraping Agent <span className="text-slate-400 font-light">Price Panel</span></h1>
              <p className="text-slate-500 font-medium">NGR Digital Intelligence Unit</p>
            </div>
          </div>
          {activeTab !== 'comparativa' && (
            <div className="flex items-center gap-3">
              <button
                onClick={handleDownload}
                className="px-4 py-2.5 bg-white text-slate-700 border border-slate-200 rounded-xl hover:bg-slate-50 shadow-sm transition-all flex items-center gap-2 font-semibold"
              >
                <ArrowDownTrayIcon className="w-5 h-5" />
                Descargar CSV
              </button>
              <button
                onClick={handleUpdate}
                disabled={updating || !selectedCompId}
                className="px-5 py-2.5 bg-slate-900 text-white rounded-xl hover:bg-slate-800 shadow-lg shadow-slate-200 transition-all flex items-center gap-2 font-semibold disabled:opacity-50"
              >
                <ArrowPathIcon className={`w-5 h-5 ${updating ? 'animate-spin' : ''}`} />
                {updating ? 'Actualizando...' : 'Actualizar Información'}
              </button>
            </div>
          )}
        </header>

        {/* Tab Selection */}
        <div className="flex border-b border-slate-200">
          <button
            onClick={() => setActiveTab('competitors')}
            className={`px-6 py-3 font-bold text-sm transition-all border-b-2 ${activeTab === 'competitors' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            Agregadores
          </button>
          <button
            onClick={() => setActiveTab('own')}
            className={`px-6 py-3 font-bold text-sm transition-all border-b-2 ${activeTab === 'own' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            Locales Propios
          </button>
          <button
            onClick={() => setActiveTab('comparativa')}
            className={`px-6 py-3 font-bold text-sm transition-all border-b-2 ${activeTab === 'comparativa' ? 'border-slate-900 text-slate-900' : 'border-transparent text-slate-400 hover:text-slate-600'}`}
          >
            Comparativa
          </button>
        </div>

        {activeTab === 'comparativa' ? (
          <Comparativa />
        ) : (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">

          {/* Selector Card */}
          <div className="md:col-span-4 bg-white rounded-2xl p-6 border border-slate-100 shadow-sm space-y-4">
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em]">Selección de Local</h2>
            <div className="space-y-4 pt-2">
              {activeTab === 'competitors' && (
                <div>
                  <label className="block text-[10px] font-bold text-slate-500 uppercase mb-2 tracking-wider">Agregador</label>
                  <div className="grid grid-cols-2 gap-2">
                    {(['Rappi', 'PedidosYa'] as const).map(opt => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setAggregator(opt)}
                        className={`py-2.5 rounded-xl text-sm font-bold transition-all cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 ${
                          aggregator === opt
                            ? 'bg-slate-900 text-white shadow-sm'
                            : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <label className="block text-[10px] font-bold text-slate-500 uppercase mb-2 tracking-wider">Punto de Venta / Competidor</label>
                <div className="relative">
                  <select
                    value={selectedCompId}
                    onChange={(e) => setSelectedCompId(e.target.value)}
                    className="w-full pl-4 pr-10 py-3 bg-slate-50 border-0 rounded-xl text-slate-900 font-bold focus:ring-2 focus:ring-slate-200 flex items-center appearance-none cursor-pointer"
                  >
                    <option value="">Seleccionar...</option>
                    {activeTab === 'competitors' ? (
                      <>
                        <optgroup label="MARCAS PROPIAS">
                          {(aggregator === 'Rappi' ? NGR_OWN_RAPPI : NGR_OWN_PEYA).map(brand => (
                            <option key={brand.id} value={brand.id}>{brand.name}</option>
                          ))}
                        </optgroup>
                        {(aggregator === 'Rappi' ? NGR_GROUPS : NGR_GROUPS_PEYA).map(group => (
                          <optgroup key={group.ngrLocal} label={`vs. ${group.ngrLocal.toUpperCase()}`}>
                            {group.competitors.map(comp => (
                              <option key={comp.id} value={comp.id}>{comp.name}</option>
                            ))}
                          </optgroup>
                        ))}
                      </>
                    ) : (
                      <>
                        {NGR_OWN_GROUPS.map(group => (
                          <optgroup key={group.ngrLocal} label={`${group.ngrLocal.toUpperCase()}`}>
                            {group.stores.map(store => (
                              <option key={store.id} value={store.id}>{store.name}</option>
                            ))}
                          </optgroup>
                        ))}
                      </>
                    )}
                  </select>
                  <ChevronDownIcon className="w-4 h-4 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

              <div className="p-4 bg-slate-50 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border border-slate-200">
                  <BuildingOfficeIcon className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Local / Sucursal</p>
                  <p className="text-sm font-bold text-slate-900 truncate max-w-[200px]" title={currentCompData?.local}>{currentCompData?.local || 'Sin datos'}</p>
                </div>
              </div>

              <div className="p-4 bg-slate-50 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border border-slate-200">
                  {currentCompData?.platform === 'Rappi' ? (
                    <GlobeAltIcon className="w-5 h-5 text-orange-400" />
                  ) : currentCompData?.platform === 'PedidosYa' ? (
                    <GlobeAltIcon className="w-5 h-5 text-pink-500" />
                  ) : (
                    <GlobeAltIcon className="w-5 h-5 text-rose-400" />
                  )}
                </div>
                <div>
                  <p className="text-[10px] font-bold text-slate-500 uppercase">{activeTab === 'own' ? 'Canal / Plataforma' : 'Agregador'}</p>
                  <p className="text-sm font-bold text-slate-900">{currentCompData?.platform || 'N/A'}</p>
                </div>
              </div>

              <div className="p-4 bg-slate-50 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border border-slate-200">
                  <ClockIcon className="w-5 h-5 text-slate-400" />
                </div>
                <div>
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Última Extracción</p>
                  <p className="text-sm font-bold text-slate-900">
                    {formatPeruDateTime(currentCompData?.lastUpdated)}
                  </p>
                </div>
              </div>

              <div className="p-4 bg-slate-50 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border border-slate-200">
                  <ShoppingBagIcon className="w-5 h-5 text-slate-400" />
                </div>
                <div>
                  <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Sku's Detectados</p>
                  <p className="text-sm font-bold text-slate-900">{currentCompData?.products.length || 0}</p>
                </div>
              </div>
            </div>
          </div>

          {/* Product Table Card */}
          <div className="md:col-span-8 bg-white rounded-2xl p-6 border border-slate-100 shadow-sm overflow-hidden flex flex-col">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 gap-4">
              <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em]">Catalogo de Precios</h2>
              <div className="relative w-full sm:w-64">
                <MagnifyingGlassIcon className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  placeholder="Filtrar por nombre o categoria..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 bg-slate-50 border-0 rounded-lg text-sm font-medium focus:ring-2 focus:ring-slate-100 placeholder:text-slate-300"
                />
              </div>
            </div>

            <div className="flex-1 overflow-auto max-h-[500px] border-t border-slate-50 pr-2 custom-scrollbar">
              <table className="w-full text-left border-separate border-spacing-0">
                <thead className="sticky top-0 bg-white z-10">
                  <tr>
                    <th className="py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">Producto</th>
                    <th className="py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100">Categoría</th>
                    <th className="py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest border-b border-slate-100 text-right">Precio Actual</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={3} className="py-16 text-center text-slate-300 italic">Consultando base de datos...</td></tr>
                  ) : filteredProducts.length === 0 ? (
                    <tr><td colSpan={3} className="py-16 text-center">
                      <div className="flex flex-col items-center gap-2 opacity-50">
                        <BuildingOfficeIcon className="w-10 h-10 text-slate-200" />
                        <p className="text-slate-400 italic text-sm">No se encontraron productos para esta selección.</p>
                      </div>
                    </td></tr>
                  ) : filteredProducts.map((p, idx) => (
                    <tr key={idx} className="hover:bg-slate-50/50 transition-colors group">
                      <td className="py-4 border-b border-slate-50">
                        <p className="font-bold text-slate-900 group-hover:text-slate-700 transition-colors">{p.name}</p>
                        <p className="text-[11px] text-slate-400 mt-0.5 line-clamp-1 truncate max-w-sm" title={p.description}>
                          {p.description || 'N/A'}
                        </p>
                      </td>
                      <td className="py-4 border-b border-slate-50">
                        <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded text-[9px] font-black uppercase tracking-wider">
                          {p.category}
                        </span>
                      </td>
                      <td className="py-4 border-b border-slate-50 text-right">
                        <p className="font-black text-slate-900 text-base">S/ {p.price.toFixed(2)}</p>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        )}

      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
        
        body {
            font-family: 'Inter', sans-serif;
        }

        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #F1F5F9;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #E2E8F0;
        }
      `}</style>
    </div>
  );
}
