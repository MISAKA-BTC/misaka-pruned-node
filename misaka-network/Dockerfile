# ── Build stage ────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/

RUN npx tsc

# ── Production stage ──────────────────────────────────────
FROM node:20-alpine

RUN addgroup -S misaka && adduser -S misaka -G misaka

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist/ dist/
COPY scripts/ scripts/

RUN mkdir -p /app/data && chown -R misaka:misaka /app

USER misaka

EXPOSE 4001 3001

HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/ --post-data='{"jsonrpc":"2.0","id":1,"method":"getInfo","params":{}}' || exit 1

ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["node", "start"]
