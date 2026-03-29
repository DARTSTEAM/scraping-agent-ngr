# 🕵️ NGR Scraping Agent — Price Intelligence Panel

> Herramienta de inteligencia de precios desarrollada por **NGR Digital Intelligence Unit**.  
> Extrae, centraliza y visualiza el catálogo de precios de competidores desde Rappi, PedidosYa y sitios propios en tiempo real.

---

## 🌐 Dashboard en vivo

**➡️ [Ver dashboard en producción](https://scraping-agent-ngr-gvxb4rjzvq-uc.a.run.app)**

---

## 📦 Estructura del Repositorio

```
Scraping Agent/
├── dashboard/              # Frontend React + Vite + TailwindCSS
│   ├── src/
│   │   ├── App.tsx         # UI principal del panel de precios
│   │   └── assets/         # Logos e imágenes
│   └── server.cjs          # Backend Express (API + SPA server)
├── rappi_scraper.js        # Scraper para restaurantes en Rappi
├── pedidosya_scraper.js    # Scraper para PedidosYa
├── mcdonalds_scraper.js    # Scraper sitio propio McDonald's
├── pizzahut_explore.js     # Exploración sitio propio Pizza Hut
├── Dockerfile              # Imagen Docker para Cloud Run
└── README.md
```

---

## 🚀 Cómo correr localmente

### 1. Backend (Express API)

```bash
cd "Scraping Agent"
npm install
node dashboard/server.cjs
# API disponible en http://localhost:3001
```

### 2. Frontend (Vite dev server)

```bash
cd dashboard
npm install
npm run dev
# UI disponible en http://localhost:5173
```

> **Nota:** El frontend en dev apunta al backend en `localhost:3001`. En producción el mismo servidor Express sirve el build compilado.

---

## 🤖 Scrapers disponibles

| Plataforma | Script | Estado |
|---|---|---|
| Rappi | `rappi_scraper.js` | ✅ Operativo |
| McDonald's Propio | `mcdonalds_scraper.js` | ✅ Operativo |
| Burger King Propio | `burgerking_scraper.js` | ✅ Operativo |
| PedidosYa | `pedidosya_scraper.js` | ⚠️ Bloqueado por Cloudflare |
| Pizza Hut Propio | `pizzahut_explore.js` | ⚠️ Bloqueado por Akamai |

### Uso del scraper de Rappi

```bash
node rappi_scraper.js <URL_DEL_RESTAURANTE_EN_RAPPI>

# Ejemplo
node rappi_scraper.js https://www.rappi.com.pe/restaurantes/742-mcdonalds
```

Los resultados se guardan como `products_<ID>.csv` y `products_<ID>.json`.

---

## 🐳 Deploy con Docker (Cloud Run)

El proyecto incluye un `Dockerfile` multi-stage:
1. **Stage 1** — compila el frontend React con Vite.
2. **Stage 2** — corre el servidor Express que sirve la API y el frontend estático.

```bash
# Build local
docker build -t scraping-agent .

# Correr local
docker run -p 8080:8080 scraping-agent
```

---

## 🔧 Stack Técnico

| Capa | Tecnología |
|---|---|
| Frontend | React 19 + TypeScript + Vite |
| Estilos | TailwindCSS v4 |
| Backend | Node.js + Express |
| Scraping | Playwright + Kernel Residential Proxy (Peru) |
| Deploy | Google Cloud Run |
| CI/CD | GitHub → Cloud Run (auto-deploy) |

---

## 📄 Licencia

Uso interno NGR — todos los derechos reservados.
