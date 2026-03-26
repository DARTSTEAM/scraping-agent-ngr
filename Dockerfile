# ──────────────────────────────────────────────
# Stage 1: Build the React / Vite dashboard
# ──────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app/dashboard

COPY dashboard/package*.json ./
RUN npm ci

COPY dashboard/ ./
RUN npm run build          # outputs to /app/dashboard/dist

# ──────────────────────────────────────────────
# Stage 2: Production server
# ──────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Copy root-level package.json & install production deps (playwright etc.)
COPY package*.json ./
# Skip playwright browser install in Cloud Run (scrapers won't run there usually)
RUN npm ci --omit=dev || npm install --omit=dev

# Copy all scraper scripts
COPY rappi_scraper.js ./
COPY mcdonalds_scraper.js ./
COPY pedidosya_scraper.js ./
COPY pizzahut_explore.js ./
COPY check_mcd.js ./
COPY dump_mcd.js ./
COPY extract_nuxt.js ./
COPY intercept_mcd.js ./

# Copy Express backend
RUN mkdir -p dashboard
COPY dashboard/server.cjs ./dashboard/server.cjs

# Copy built frontend from Stage 1
COPY --from=builder /app/dashboard/dist ./dashboard/dist

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dashboard/server.cjs"]
