/**
 * ИИ-ассистент, перенос лицензий, колокольчик, импорт из Excel. Логика: services/ai.ts, reallocation.ts,
 * notifications.ts, importer.ts. Контракт: docs/API.md §14–17.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db.ts";
import { chat, EXAMPLES, llmEnabled, llmInfo, starters } from "../services/ai.ts";
import { analyzeEula, approveSoftware, FetchError } from "../services/eula.ts";
import { importRows, template, type ImportKind } from "../services/importer.ts";
import { notifications } from "../services/notifications.ts";
import { reallocation } from "../services/reallocation.ts";
import { parseUpload, UploadError } from "../services/tabular.ts";
import { body } from "./util.ts";

const KINDS = ["employees", "catalog", "purchases"] as const;
const chatBody = z.object({ question: z.string().trim().min(1).max(2000) });
const eulaBody = z.object({ input: z.string().trim().min(2).max(50_000) });
const kind = z.enum(["open_source", "freeware", "shareware", "trial", "commercial"]);
const approveBody = z.strictObject({
  name: z.string().trim().min(1).max(200),
  vendor: z.string().trim().max(200).nullish(),
  purpose: z.string().trim().max(1000).nullish(),
  license_kind: kind,
  internal_status: z.enum(["current", "outdated", "forbidden"]).default("current"),
  license_name: z.string().trim().max(200).nullish(),
  commercial_use: z.enum(["allowed", "restricted", "forbidden", "unknown"]).optional(),
  copyleft: z.boolean().nullish(),
  min_version: z.string().trim().max(50).nullish(),
  analysis: z.unknown().optional(),
});

export function assistantRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/ai/info", async () => ({
    llm: llmEnabled(),
    ...llmInfo(),
    examples: EXAMPLES,
    starters: starters(db),
  }));

  // EULA: ссылка / название / текст → анализ; затем «добавить в одобренное ПО»
  app.post("/api/ai/eula", async (req, reply) => {
    const d = body(eulaBody, req.body, reply);
    if (!d) return;
    try {
      return await analyzeEula(db, d.input);
    } catch (e) {
      if (e instanceof FetchError)
        return reply.code(400).send({ error: `не удалось загрузить страницу: ${e.message}` });
      throw e;
    }
  });
  app.post("/api/ai/eula/approve", async (req, reply) => {
    const d = body(approveBody, req.body, reply);
    if (!d) return;
    return reply.code(201).send(approveSoftware(db, d));
  });
  app.post("/api/ai/chat", async (req, reply) => {
    const d = body(chatBody, req.body, reply);
    if (!d) return;
    return chat(db, d.question);
  });

  app.get("/api/licenses/reallocation", async () => reallocation(db));
  app.get("/api/notifications", async () => notifications(db));

  app.get<{ Params: { kind: string } }>("/api/import/templates/:kind", async (req, reply) => {
    const kind = req.params.kind.replace(/\.xlsx$/, "") as ImportKind;
    if (!KINDS.includes(kind)) return reply.code(404).send({ error: "шаблоны: employees, catalog, purchases" });
    return reply
      .header("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .header("content-disposition", `attachment; filename="easysam-${kind}.xlsx"`)
      .send(await template(kind));
  });

  app.post<{ Params: { kind: string }; Querystring: { dry_run?: string } }>("/api/import/:kind", async (req, reply) => {
    const kind = req.params.kind as ImportKind;
    if (!KINDS.includes(kind)) return reply.code(404).send({ error: "импорт: employees, catalog, purchases" });
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "нужен файл в поле file (.xlsx или .csv)" });
    try {
      const rows = await parseUpload(file.filename, await file.toBuffer());
      return importRows(db, kind, rows, req.query.dry_run === "1" || req.query.dry_run === "true");
    } catch (e) {
      if (e instanceof UploadError || e instanceof Error) return reply.code(400).send({ error: (e as Error).message });
      throw e;
    }
  });
}
