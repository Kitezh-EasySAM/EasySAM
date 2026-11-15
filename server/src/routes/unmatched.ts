/**
 * «Неопознанное»: GET /api/unmatched, POST /api/unmatched/resolve, POST /api/unmatched/ai-suggest. Логика:
 * services/unmatched.ts, aiMatch.ts. Контракт: docs/API.md §7
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db.ts";
import { ignoreNames, listUnmatched, resolveToCatalog } from "../services/unmatched.ts";
import { llmEnabled } from "../services/ai.ts";
import { AI_MATCH_MAX, aiSuggest } from "../services/aiMatch.ts";
import { body } from "./util.ts";

const names = z.array(z.string().min(1).max(500)).min(1).max(500);
const resolveBody = z.union([
  z.strictObject({ norm_names: names, catalog_id: z.number().int().positive() }),
  z.strictObject({ norm_names: names, ignore: z.literal(true) }),
]);

export function unmatchedRoutes(app: FastifyInstance, db: DB) {
  app.get<{ Querystring: { q?: string; limit?: string; offset?: string } }>("/api/unmatched", async (req) =>
    listUnmatched(db, {
      q: req.query.q,
      limit: Math.min(Math.max(Number(req.query.limit) || 50, 1), 200),
      offset: Math.max(Number(req.query.offset) || 0, 0),
    }),
  );

  app.post("/api/unmatched/resolve", async (req, reply) => {
    const data = body(resolveBody, req.body, reply);
    if (!data) return;
    if ("catalog_id" in data) {
      if (!db.prepare("SELECT 1 FROM software_catalog WHERE id = ?").get(data.catalog_id))
        return reply.code(400).send({ error: "catalog_id: нет такой позиции каталога" });
      return { updated_installations: resolveToCatalog(db, data.norm_names, data.catalog_id) };
    }
    return { updated_installations: ignoreNames(db, data.norm_names) };
  });

  // ИИ-подсказки (Smart Matching): ничего не меняет — привязку подтверждает человек через /resolve
  app.post("/api/unmatched/ai-suggest", async (req, reply) => {
    const data = body(z.strictObject({ norm_names: names.max(AI_MATCH_MAX) }), req.body, reply);
    if (!data) return;
    if (!llmEnabled())
      return reply.code(409).send({ error: "ИИ-модель не подключена (OPENAI_API_KEY или OPENAI_BASE_URL)" });
    try {
      return { items: await aiSuggest(db, data.norm_names) };
    } catch (e) {
      return reply.code(502).send({ error: `ИИ-модель не ответила: ${(e as Error).message}` });
    }
  });
}
