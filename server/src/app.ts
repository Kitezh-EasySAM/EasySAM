/** Сборка Fastify-приложения. Новый домен: routes/<имя>.ts → подключить здесь → описать в docs/API.md. */
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { DB } from "./db.ts";
import { catalogRoutes } from "./routes/catalog.ts";
import { complianceRoutes } from "./routes/compliance.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { employeeRoutes } from "./routes/employees.ts";
import { ingestRoutes } from "./routes/ingest.ts";
import { licensePoolRoutes } from "./routes/licensePool.ts";
import { licenseKeyRoutes } from "./routes/licenses.ts";
import { processRoutes } from "./routes/processes.ts";
import { rematchAllProcesses } from "./services/processes.ts";
import { purchaseRoutes } from "./routes/purchases.ts";
import { streamRoutes } from "./routes/stream.ts";
import { unmatchedRoutes } from "./routes/unmatched.ts";
import { authHooks } from "./routes/auth.ts";
import { agentAuthRoutes } from "./routes/agentAuth.ts";
import { assistantRoutes } from "./routes/assistant.ts";
import { userRoutes } from "./routes/users.ts";
import { reportRoutes } from "./routes/reports.ts";
import { config } from "./config.ts";

export async function buildApp(db: DB) {
  rematchAllProcesses(db); // правила сопоставления процессов могли измениться — привести историю к ним
  const app = Fastify({ logger: false, trustProxy: config.trustProxy });
  // CORS только если фронт на другом адресе (CORS_ORIGIN); по умолчанию фронт ходит через тот же адрес/прокси
  if (config.corsOrigin)
    await app.register(cors, { origin: config.corsOrigin.split(",").map((o) => o.trim()), credentials: true });
  authHooks(app, db); // токены агентов (общий / на каждый ПК) и администратора — routes/auth.ts
  // ошибки ограничений SQLite → понятные 409 вместо 500
  app.setErrorHandler((e, _req, reply) => {
    const err = e as { message?: string; statusCode?: number };
    const msg = String(err.message);
    if (msg.includes("UNIQUE constraint failed"))
      return reply.code(409).send({ error: "запись с таким именем уже существует" });
    if (msg.includes("FOREIGN KEY constraint failed")) return reply.code(409).send({ error: "есть связанные записи" });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: msg });
    app.log.error(err);
    return reply.code(500).send({ error: "внутренняя ошибка сервера" });
  });
  app.get("/api/health", async () => ({ status: "ok" }));
  await ingestRoutes(app, db);
  complianceRoutes(app, db);
  deviceRoutes(app, db);
  catalogRoutes(app, db);
  purchaseRoutes(app, db);
  employeeRoutes(app, db);
  unmatchedRoutes(app, db);
  licenseKeyRoutes(app, db);
  processRoutes(app, db);
  licensePoolRoutes(app, db);
  agentAuthRoutes(app, db);
  assistantRoutes(app, db);
  userRoutes(app, db);
  reportRoutes(app, db);
  streamRoutes(app, db);
  await staticFiles(app);
  return app;
}

/**
 * Собранный фронт на «/» (адреса SPA → index.html) и файлы агента на «/downloads/». Только если папки заданы и есть.
 */
async function staticFiles(app: FastifyInstance) {
  const agent = config.agentDist && existsSync(config.agentDist) ? path.resolve(config.agentDist) : "";
  if (agent)
    await app.register(fastifyStatic, {
      root: agent,
      prefix: "/downloads/",
      decorateReply: false,
      index: false,
      allowedPath: (p) => /\.(exe|ps1)$/i.test(p),
    }); // рядом может лежать sam-agent.json с ключом — его не отдаём
  const web = config.webDist && existsSync(path.join(config.webDist, "index.html")) ? path.resolve(config.webDist) : "";
  if (!web) return;
  await app.register(fastifyStatic, {
    root: web,
    prefix: "/",
    wildcard: false,
    index: ["index.html"],
    // файлы со хешем в имени (assets/) неизменны — кешируем надолго; index.html — всегда свежий
    setHeaders: (res, file) =>
      res.header(
        "Cache-Control",
        file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
      ),
  });
  app.setNotFoundHandler((req, reply) => {
    const url = req.url.split("?")[0];
    if (req.method !== "GET" || url.startsWith("/api/") || url.startsWith("/downloads/") || path.extname(url))
      return reply.code(404).send({ error: "не найдено" });
    return reply.header("Cache-Control", "no-cache").sendFile("index.html", web);
  });
}
