#!/bin/sh
# Старт контейнера: при пустом томе — реальные данные из материалы/ (перечень, лицензии, 187 ПК), DEMO=1 — ещё и демо,
# затем API (+ фронт и /downloads). Демо в работающий контейнер: docker compose exec sam node src/scripts/run-demo.ts
set -e
# модель на хосте: из контейнера localhost — это сам контейнер, а не ноутбук
case "$OPENAI_BASE_URL" in
  *://localhost*|*://127.0.0.1*)
    OPENAI_BASE_URL=$(echo "$OPENAI_BASE_URL" | sed -E 's#://(localhost|127\.0\.0\.1)#://host.docker.internal#')
    export OPENAI_BASE_URL
    echo "[sam] адрес модели для контейнера: $OPENAI_BASE_URL"
    ;;
esac
if [ "$SEED" != "0" ] && [ ! -f "$DB_PATH" ]; then
  echo "[sam] БД не найдена ($DB_PATH) — наполняю seed-данными…"
  if [ "$DEMO" = "1" ]; then node src/scripts/run-seed.ts --demo; else node src/scripts/run-seed.ts; fi
fi
[ -f "$AGENT_DIST/sam-agent.exe" ] && echo "[sam] агент для ПК: /downloads/sam-agent.exe" || echo "[sam] агент в образ не собран (AGENT=0)"
echo "[sam] интерфейс и API на :$PORT"
exec node src/index.ts
