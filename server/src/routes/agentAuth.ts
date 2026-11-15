/**
 * Регистрация агентов и управление токенами. Логика: services/agentAuth.ts. Контракт: docs/API.md «Доступ», §13.
 *   агент:   POST /api/agent/enroll (без токена, по ключу регистрации)
 *   админ:   GET/POST /api/agent-enroll-keys, DELETE /api/agent-enroll-keys/:id (отозвать)
 *            GET /api/agent-tokens, DELETE /api/agent-tokens/:id (отозвать токен ПК)
 *            GET /api/agent-config/defaults, POST /api/agent-config → новый ключ + готовый sam-agent.json (скачивание)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db.ts";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.ts";
import {
  agentConfigFile,
  createEnrollKey,
  enroll,
  EnrollError,
  listAgentTokens,
  listEnrollKeys,
  normalizeServerUrl,
} from "../services/agentAuth.ts";
import { body, dateStr, parseId } from "./util.ts";

const enrollBody = z.object({
  enroll_key: z.string().min(10).max(200),
  serial_number: z.string().min(1).max(200),
  hostname: z.string().max(200).nullish(),
  os: z.string().max(200).nullish(),
});
const keyBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  max_uses: z.number().int().min(1).max(1_000_000).nullish(),
  expires_at: dateStr.nullish(),
});

const configBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  server: z.string().trim().min(3).max(300),
  max_uses: z.number().int().min(1).max(1_000_000).nullish(),
  days: z.number().int().min(1).max(3650).nullish(),
  interval: z.number().int().min(10).max(86_400).optional(),
  usage_interval: z.number().int().min(30).max(86_400).optional(),
});

export function agentAuthRoutes(app: FastifyInstance, db: DB) {
  // что подставить в форму «Подключить агента»: адрес из PUBLIC_URL и есть ли sam-agent.exe для скачивания
  app.get("/api/agent-config/defaults", async () => ({
    public_url: config.publicUrl ? normalizeServerUrl(config.publicUrl) : null,
    agent_exe: !!config.agentDist && existsSync(path.join(config.agentDist, "sam-agent.exe")),
  }));

  // новый ключ регистрации + готовый sam-agent.json (ключ в открытом виде — только в этом ответе)
  app.post("/api/agent-config", async (req, reply) => {
    const d = body(configBody, req.body, reply);
    if (!d) return;
    const server = normalizeServerUrl(d.server);
    if (!server)
      return reply
        .code(400)
        .send({ error: "адрес сервера: http://хост:порт (без пути), например http://192.168.249.1:8000" });
    const expires_at = d.days ? new Date(Date.now() + d.days * 86_400_000).toISOString().slice(0, 10) : null;
    const { id, key } = createEnrollKey(db, { title: d.title, max_uses: d.max_uses ?? null, expires_at });
    const file = agentConfigFile({
      server,
      enrollKey: key,
      title: d.title,
      expiresAt: expires_at,
      maxUses: d.max_uses,
      interval: d.interval,
      usageInterval: d.usage_interval,
    });
    return reply
      .header("content-disposition", 'attachment; filename="sam-agent.json"')
      .header("x-enroll-key-id", String(id))
      .type("application/json; charset=utf-8")
      .send(JSON.stringify(file, null, 2) + "\n");
  });

  app.post("/api/agent/enroll", async (req, reply) => {
    const d = body(enrollBody, req.body, reply);
    if (!d) return;
    try {
      return enroll(db, d);
    } catch (e) {
      if (e instanceof EnrollError) return reply.code(403).send({ error: e.message });
      throw e;
    }
  });

  app.get("/api/agent-enroll-keys", async () => listEnrollKeys(db));
  app.post("/api/agent-enroll-keys", async (req, reply) => {
    const d = body(keyBody, req.body, reply);
    if (!d) return;
    const { id, key } = createEnrollKey(db, d);
    // открытый ключ отдаётся ОДИН раз — его вставляют в установщик
    return reply.code(201).send({ ...listEnrollKeys(db).find((k) => k.id === id), key });
  });
  app.delete<{ Params: { id: string } }>("/api/agent-enroll-keys/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id || !db.prepare("UPDATE enroll_key SET revoked = 1 WHERE id = ?").run(id).changes)
      return reply.code(404).send({ error: "не найдено" });
    return reply.code(204).send();
  });

  app.get("/api/agent-tokens", async () => listAgentTokens(db));
  app.delete<{ Params: { id: string } }>("/api/agent-tokens/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id || !db.prepare("UPDATE agent_token SET revoked = 1 WHERE id = ?").run(id).changes)
      return reply.code(404).send({ error: "не найдено" });
    return reply.code(204).send();
  });
}
