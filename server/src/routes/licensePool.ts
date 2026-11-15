/**
 * Хранилище ключей, раздача на ПК, обзор по продуктам, команды агентам. Логика: services/licensePool.ts. Контракт:
 *   docs/API.md §12
 *   GET/POST /api/license-pool, PATCH/DELETE /api/license-pool/:id, POST /api/license-pool/:id/deploy
 *   GET /api/license-pool/products (продукты для формы), GET /api/license-products, GET /api/agent-commands
 *   агент (X-Ingest-Token): GET /api/agent/commands?serial=…, POST /api/agent/commands/:id/result
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { one, type DB } from "../db.ts";
import {
  deploy,
  DeployError,
  finishCommand,
  keyTail,
  maskKeys,
  listCommands,
  listPool,
  PRODUCTS,
  productList,
  productOverview,
  publicPool,
  takeCommands,
  type PoolRow,
} from "../services/licensePool.ts";
import { touchAgent } from "../services/ingest.ts";
import { publish } from "../services/stream.ts";
import { body, dateStr, parseId, updateRow } from "./util.ts";
import { deviceTokenSerial } from "./auth.ts";

const product = z.enum(Object.keys(PRODUCTS) as [string, ...string[]]);
const fields = {
  product,
  title: z.string().trim().min(1).max(200),
  license_key: z
    .string()
    .trim()
    .min(5)
    .max(200)
    .regex(/^[0-9A-Za-z-]+$/, "ключ: буквы, цифры и дефисы"),
  seats: z.number().int().min(1).max(1_000_000),
  valid_until: dateStr.nullish(),
  license_type: z.string().max(100).nullish(),
  note: z.string().max(1000).nullish(),
};
const create = z.strictObject({ ...fields, seats: fields.seats.default(1) });
const patch = z
  .strictObject({
    title: fields.title,
    seats: fields.seats,
    valid_until: fields.valid_until,
    license_type: fields.license_type,
    note: fields.note,
  })
  .partial();
const deployBody = z
  .strictObject({
    devices: z.array(z.string().min(1)).min(1).max(5000).optional(),
    filter: z.enum(["expired", "expiring", "trial", "unlicensed", "without"]).optional(),
  })
  .refine((b) => !!b.devices !== !!b.filter, "нужно ровно одно: devices или filter");
const resultBody = z.object({
  serial_number: z.string().min(1),
  ok: z.boolean(),
  output: z.string().max(10_000).default(""),
});

export function licensePoolRoutes(app: FastifyInstance, db: DB) {
  const get = (id: number) => {
    const p = one<PoolRow>(db, "SELECT * FROM license_pool WHERE id = ?", id);
    return p && publicPool(db, p);
  };

  app.get<{ Querystring: { product?: string } }>("/api/license-pool", async (req) => listPool(db, req.query.product));
  app.get("/api/license-pool/products", async () => productList());

  app.post("/api/license-pool", async (req, reply) => {
    const d = body(create, req.body, reply);
    if (!d) return;
    const id = Number(
      db
        .prepare(
          `INSERT INTO license_pool (product, title, license_key, key_tail, seats, valid_until, license_type, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          d.product,
          d.title,
          d.license_key.toUpperCase(),
          keyTail(d.license_key),
          d.seats,
          d.valid_until ?? null,
          d.license_type ?? null,
          d.note ?? null,
        ).lastInsertRowid,
    );
    return reply.code(201).send(get(id));
  });

  app.patch<{ Params: { id: string } }>("/api/license-pool/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const d = body(patch, req.body, reply);
    if (!d) return;
    if (!id || !updateRow(db, "license_pool", "id", id, d)) return reply.code(404).send({ error: "не найдено" });
    return get(id);
  });

  app.delete<{ Params: { id: string } }>("/api/license-pool/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id || !get(id)) return reply.code(404).send({ error: "не найдено" });
    db.prepare(
      "UPDATE agent_command SET status = 'cancelled', updated_at = datetime('now') WHERE pool_id = ? AND status IN ('pending','sent')",
    ).run(id);
    db.prepare("UPDATE agent_command SET pool_id = NULL WHERE pool_id = ?").run(id);
    db.prepare("DELETE FROM license_pool WHERE id = ?").run(id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/license-pool/:id/deploy", async (req, reply) => {
    const id = parseId(req.params.id);
    const d = body(deployBody, req.body, reply);
    if (!d) return;
    try {
      return deploy(db, id ?? -1, d.devices ?? (d.filter as "expired"));
    } catch (e) {
      if (e instanceof DeployError) return reply.code(409).send({ error: e.message });
      throw e;
    }
  });

  app.get("/api/license-products", async () => productOverview(db));

  app.get<{ Querystring: { status?: string; device?: string } }>("/api/agent-commands", async (req) =>
    listCommands(db, { status: req.query.status, device: req.query.device }),
  );

  // ---- канал агента (токен проверяет routes/auth.ts)
  app.get<{ Querystring: { serial?: string } }>("/api/agent/commands", async (req, reply) => {
    if (!req.query.serial) return reply.code(400).send({ error: "нужен serial" });
    touchAgent(db, req.query.serial); // опрос заданий = сердцебиение агента
    return takeCommands(db, req.query.serial, deviceTokenSerial(req) !== null); // ключи — только по токену своего ПК
  });

  app.post<{ Params: { id: string } }>("/api/agent/commands/:id/result", async (req, reply) => {
    const id = parseId(req.params.id);
    const d = body(resultBody, req.body, reply);
    if (!d) return;
    d.output = maskKeys(d.output); // вывод cpconfig содержит полный серийный номер — в БД и в ленту только хвост
    if (!id || !finishCommand(db, d.serial_number, id, d.ok, d.output))
      return reply.code(404).send({ error: "команда не найдена или уже закрыта" });
    const c = db
      .prepare(
        `SELECT c.type, c.product, d.hostname, p.title FROM agent_command c
         LEFT JOIN device d ON d.serial_number = c.device_serial LEFT JOIN license_pool p ON p.id = c.pool_id
         WHERE c.id = ?`,
      )
      .get(id) as { type: string; product: string; hostname: string | null; title: string | null };
    const host = c.hostname ?? d.serial_number;
    const text =
      c.type === "snapshot"
        ? d.ok
          ? `${host}: агент отправил свежий снимок`
          : `${host}: снимок не получен: ${d.output.slice(0, 200)}`
        : d.ok
          ? `Ключ «${c.title ?? c.product}» установлен на ${host}`
          : `Не удалось установить ключ «${c.title ?? c.product}» на ${host}: ${d.output.slice(0, 200)}`;
    publish({
      event: "command",
      data: { id, device_serial: d.serial_number, hostname: c.hostname, product: c.product, ok: d.ok, text },
    });
    return { ok: true };
  });
}
