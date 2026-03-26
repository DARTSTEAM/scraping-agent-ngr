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

const API_BASE = 'http://localhost:3001/api';

const COMPETITORS = [
  { name: "McDonald's (San Antonio)", url: "https://www.rappi.com.pe/restaurantes/742-mcdonalds", id: '742', platform: 'Rappi' },
  { name: "KFC (Surquillo)", url: "https://www.rappi.com.pe/restaurantes/6337-kfc", id: '6337', platform: 'Rappi' },
  { name: "Starbucks", url: "https://www.rappi.com.pe/restaurantes/38002-starbucks", id: '38002', platform: 'Rappi' },
  { name: "McDonald's (Ovalo Gutierrez)", url: "https://www.pedidosya.com.pe/restaurantes/lima/mcdonalds-ovalo-gutierrez-e6b6652e-45c6-44f7-8976-e376edf475a8-menu", id: 'mcd-ovalo-gutierrez', platform: 'PedidosYa' },
  { name: "McDonald's (Izaguirre)", url: "https://www.mcdonalds.com.pe/restaurantes/independencia/izaguirre-iza/pedidos", id: 'mcd-izaguirre-iza', platform: 'McDonalds Propio' },
  { name: "Pizza Hut (Miraflores)", url: "https://www.pizzahut.com.pe/order", id: 'pizzahut-miraflores', platform: 'Pizza Hut Propio' }
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
  const [activeTab, setActiveTab] = useState<'competitors' | 'own'>('competitors'); // New tabs

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
    activeTab === 'competitors' ? (c.platform === 'Rappi' || c.platform === 'PedidosYa') : (c.platform === 'McDonalds Propio' || c.platform === 'Pizza Hut Propio')
  );

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (filteredCompetitors.length > 0 && !filteredCompetitors.find(c => c.id === selectedCompId)) {
      setSelectedCompId(filteredCompetitors[0].id);
    }
  }, [activeTab, data]);

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
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">

          {/* Selector Card */}
          <div className="md:col-span-4 bg-white rounded-2xl p-6 border border-slate-100 shadow-sm space-y-4">
            <h2 className="text-xs font-black text-slate-400 uppercase tracking-[0.2em]">Selección de Local</h2>
            <div className="space-y-4 pt-2">
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
                        <optgroup label="RAPPI">
                          {COMPETITORS.filter(c => c.platform === 'Rappi').map(comp => (
                            <option key={comp.id} value={comp.id}>{comp.name}</option>
                          ))}
                        </optgroup>
                        <optgroup label="PEDIDOS YA">
                          {COMPETITORS.filter(c => c.platform === 'PedidosYa').map(comp => (
                            <option key={comp.id} value={comp.id}>{comp.name}</option>
                          ))}
                        </optgroup>
                      </>
                    ) : (
                      <>
                        <optgroup label="MCDONALDS PROPIO">
                          {COMPETITORS.filter(c => c.platform === 'McDonalds Propio').map(comp => (
                            <option key={comp.id} value={comp.id}>{comp.name}</option>
                          ))}
                        </optgroup>
                        <optgroup label="PIZZA HUT PROPIO">
                          {COMPETITORS.filter(c => c.platform === 'Pizza Hut Propio').map(comp => (
                            <option key={comp.id} value={comp.id}>{comp.name}</option>
                          ))}
                        </optgroup>
                      </>
                    )}
                  </select>
                  <ChevronDownIcon className="w-4 h-4 text-slate-400 absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>

              <div className="p-4 bg-slate-50 rounded-xl flex items-center gap-4">
                <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center border border-slate-200">
                  {currentCompData?.platform === 'Rappi' ? <GlobeAltIcon className="w-5 h-5 text-orange-400" /> : <GlobeAltIcon className="w-5 h-5 text-rose-400" />}
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
                    {currentCompData?.lastUpdated ? new Date(currentCompData.lastUpdated).toLocaleString('es-PE') : 'N/A'}
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
