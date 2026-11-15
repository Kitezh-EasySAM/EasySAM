/** Настройки из переменных окружения (см. .env.example). Единственное место чтения process.env. */
export const config = {
  port: Number(process.env.PORT ?? 8000),
  dbPath: process.env.DB_PATH ?? "sam.db",
  ingestToken: process.env.INGEST_TOKEN ?? "", // общий токен агентов (X-Ingest-Token); пусто = выключен, только токены ПК
  adminToken: process.env.ADMIN_TOKEN ?? "", // для скриптов: Authorization: Bearer … (права admin); пусто = выключено
  // вход в интерфейс: login (по умолчанию) — логин/пароль и cookie-сессия; off — всё открыто (только тесты и
  // локальная отладка)
  authMode: (process.env.AUTH ?? "login").toLowerCase() === "off" ? ("off" as const) : ("login" as const),
  adminPassword: process.env.ADMIN_PASSWORD ?? "", // пароль первого пользователя admin (пусто — «admin»); в любом случае временный: сменить при первом входе
  sessionHours: Number(process.env.SESSION_HOURS ?? 12),
  cookieSecure: ["1", "true", "yes"].includes((process.env.COOKIE_SECURE ?? "").toLowerCase()), // 1 — только по HTTPS
  corsOrigin: process.env.CORS_ORIGIN ?? "", // пусто — CORS выключен (фронт через тот же адрес/прокси)
  trustProxy: ["1", "true", "yes"].includes((process.env.TRUST_PROXY ?? "").toLowerCase()), // за nginx: IP клиента из X-Forwarded-For
  // 1 = агенты только с собственным токеном ПК (X-Agent-Token); общий INGEST_TOKEN не принимается
  requireDeviceToken: ["1", "true", "yes"].includes((process.env.REQUIRE_DEVICE_TOKEN ?? "").toLowerCase()),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "", // пусто = ИИ выключен (фолбэк)
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "", // локальная модель / совместимый провайдер
  llmModel: process.env.LLM_MODEL ?? "gpt-4o-mini",
  llmTimeoutMs: Number(process.env.LLM_TIMEOUT_MS ?? 120_000), // локальная модель на первом запросе грузится долго
  llmMaxConcurrent: Number(process.env.LLM_MAX_CONCURRENT ?? 2), // одновременных запросов к модели; сверх — «модель занята»
  sqlTimeoutMs: Number(process.env.SQL_TIMEOUT_MS ?? 5000), // SQL от модели — не дольше (выполняется в отдельном потоке)
  eulaFetch: (process.env.EULA_FETCH ?? "on").toLowerCase() !== "off", // off — не ходить в интернет за текстом лицензии
  staleDays: Number(process.env.STALE_DAYS ?? 90), // «зомби»: не запускали N дней
  agentOnlineSeconds: Number(process.env.AGENT_ONLINE_SECONDS ?? 300), // агент «в сети», если выходил на связь за N с
  // собранный фронт (vite build) — сервер отдаёт его сам на «/» (Docker); пусто/нет папки — только API (dev: фронт
  // на :5173)
  webDist: process.env.WEB_DIST ?? "",
  // файлы агента для скачивания на ПК (exe + установщики) — «/downloads/…»; пусто/нет папки — выключено
  // по умолчанию — папка `make agent-dist`; отдаются только *.exe и *.ps1 (sam-agent.json с ключом — никогда)
  agentDist: process.env.AGENT_DIST ?? "../agent/dist/sam-agent",
  // адрес сервера, который видят ПК (http://192.168.249.1:8000) — подставляется в sam-agent.json; пусто — адрес из
  // браузера
  publicUrl: process.env.PUBLIC_URL ?? "",
};
