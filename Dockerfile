# ──────────────────────────────────────────────
# Stage 1: Build the React / Vite dashboard
# ──────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app/dashboard

COPY dashboard/package*.json ./
# Use npm install to ensure package-lock is regenerated if needed
RUN npm install

COPY dashboard/ ./
# Verify index.html is present before building
RUN ls -la && npm run build

# ──────────────────────────────────────────────
# Stage 2: Production server
# ──────────────────────────────────────────────
FROM node:20-slim

WORKDIR /app

# Install production deps for the root (scrapers)
COPY package*.json ./
RUN npm install --omit=dev

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
COPY dashboard/package*.json ./dashboard/
RUN cd dashboard && npm install --omit=dev
COPY dashboard/server.cjs ./dashboard/server.cjs

# Copy built frontend from Stage 1
COPY --from=builder /app/dashboard/dist ./dashboard/dist

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dashboard/server.cjs"]
