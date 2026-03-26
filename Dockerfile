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

# Copy root scraper deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy scrapers & shared assets
COPY *.js ./

# Copy Express server
COPY dashboard/server.cjs ./dashboard/server.cjs

# Copy built frontend from Stage 1
COPY --from=builder /app/dashboard/dist ./dashboard/dist

# Copy data directory (will be empty initially but mounted at runtime if needed)
RUN mkdir -p ./data

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dashboard/server.cjs"]
