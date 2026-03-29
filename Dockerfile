# ──────────────────────────────────────────────
# Stage 1: Build the React / Vite dashboard
# ──────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app/dashboard

COPY dashboard/package*.json ./
RUN npm install

COPY dashboard/ ./
RUN npm run build   # outputs to /app/dashboard/dist

# ──────────────────────────────────────────────
# Stage 2: Production server with Playwright
# ──────────────────────────────────────────────
FROM node:20-slim

# Install OS-level deps required by Playwright/Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libasound2 \
    wget ca-certificates fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install root-level dependencies (playwright, etc.)
COPY package*.json ./
RUN npm install --omit=dev

# Install Chromium browser for Playwright
RUN npx playwright install chromium

# Copy scraper scripts and shared helpers
COPY rappi_scraper.js ./
COPY mcdonalds_scraper.js ./
COPY pedidosya_scraper.js ./
COPY pizzahut_explore.js ./
COPY burgerking_scraper.js ./
COPY kfc_scraper.js ./
COPY kernel_browser.js ./
COPY check_mcd.js ./
COPY dump_mcd.js ./
COPY extract_nuxt.js ./
COPY intercept_mcd.js ./

# Copy scraped product data (committed to git as baseline dataset)
COPY data/ ./

# Set up dashboard directory
RUN mkdir -p dashboard

# Install dashboard's runtime dependencies (express, cors)
COPY dashboard/package*.json ./dashboard/
RUN cd dashboard && npm install --omit=dev

# Copy Express backend
COPY dashboard/server.cjs ./dashboard/server.cjs

# Copy compiled React app from Stage 1
COPY --from=builder /app/dashboard/dist ./dashboard/dist

# Cloud Run injects PORT (default 8080)
ENV PORT=8080
# Required for Playwright to run without a sandbox in containers
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

EXPOSE 8080

CMD ["node", "dashboard/server.cjs"]
