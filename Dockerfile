# EasySAM целиком в одном образе: API (Node 26 + TypeScript без сборки) + собранный фронт + агент для Windows.
#   http://host:8000/            — интерфейс (фронт отдаёт сам API-сервер, прокси не нужен)
#   http://host:8000/api/…       — API (агенты, интерфейс)
#   http://host:8000/downloads/  — sam-agent.exe и установщики *.ps1 для ПК
# SQLite в томе /data. Первый старт с пустым томом: стартовый каталог (отключить: SEED=0).
# Агент собирается кросс-компиляцией (mingw) — первая сборка образа ~5 мин, дальше слои кешируются.
# Без агента (быстрее): docker compose build --build-arg AGENT=0

# ---------- 1. фронт ----------
FROM node:26-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- 2. агент (Windows exe из Linux) ----------
FROM rust:1.93-slim-bookworm AS agent
ARG AGENT=1
RUN if [ "$AGENT" = "1" ]; then apt-get update && apt-get install -y --no-install-recommends gcc-mingw-w64-x86-64 \
      && rm -rf /var/lib/apt/lists/* && rustup target add x86_64-pc-windows-gnu; fi
WORKDIR /agent
COPY agent/Cargo.toml agent/Cargo.lock ./
COPY agent/src src
COPY agent/install install
RUN mkdir -p /out && if [ "$AGENT" = "1" ]; then \
      cargo build --release --locked --target x86_64-pc-windows-gnu \
      && cp target/x86_64-pc-windows-gnu/release/sam-agent.exe /out/; fi \
    && cp install/*.ps1 /out/

# ---------- 3. сервер ----------
FROM node:26-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000 \
    DB_PATH=/data/sam.db \
    SEED=1 \
    DEMO=0 \
    WEB_DIST=/app/web/dist \
    AGENT_DIST=/app/agent-dist

# зависимости отдельным слоем (кешируется, пока не менялся lock-файл)
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
RUN npm ci --ignore-scripts --omit=dev --workspace server --no-audit --no-fund && npm cache clean --force

COPY server/src server/src
COPY server/assets server/assets
COPY server/docker-entrypoint.sh server/docker-entrypoint.sh
COPY --from=web /web/dist web/dist
COPY --from=agent /out agent-dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/server
ENTRYPOINT ["sh", "docker-entrypoint.sh"]
