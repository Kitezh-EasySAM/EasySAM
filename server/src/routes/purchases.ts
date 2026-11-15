/** Закупки мест (то, что «куплено»). Контракт: docs/API.md §4 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db.ts";
import { getPurchase, listPurchases, purchaseSummary } from "../services/purchases.ts";
import { body, dateStr, insertRow, parseId, updateRow } from "./util.ts";

const fields = {
  catalog_id: z.number().int().positive(),
  seats: z.number().int().min(0).max(1_000_000),
  unit_price: z.number().min(0),
  valid_until: dateStr.nullish(),
  contract: z.string().max(200).nullish(),
};
const create = z.strictObject({ ...fields, unit_price: z.number().min(0).default(0) });
const patch = z.strictObject(fields).partial();

export function purchaseRoutes(app: FastifyInstance, db: DB) {
  const get = (id: number) => getPurchase(db, id);
  const catalogExists = (id: number) => !!db.prepare("SELECT 1 FROM software_catalog WHERE id = ?").get(id);

  app.get<{ Querystring: { catalog_id?: string; status?: string; q?: string } }>("/api/purchases", async (req) =>
    listPurchases(db, {
      catalog_id: req.query.catalog_id ? Number(req.query.catalog_id) : null,
      status: req.query.status,
      q: req.query.q,
    }),
  );

  // ?days=90 — окно «истекают» (по умолчанию 30)
  app.get<{ Querystring: { days?: string } }>("/api/purchases/summary", async (req) =>
    purchaseSummary(db, Math.min(Math.max(Number(req.query.days) || 30, 1), 3650)),
  );

  app.post("/api/purchases", async (req, reply) => {
    const data = body(create, req.body, reply);
    if (!data) return;
    if (!catalogExists(data.catalog_id))
      return reply.code(400).send({ error: "catalog_id: нет такой позиции каталога" });
    return reply.code(201).send(get(insertRow(db, "license_purchase", data)));
  });

  app.patch<{ Params: { id: string } }>("/api/purchases/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const data = body(patch, req.body, reply);
    if (!data) return;
    if (data.catalog_id && !catalogExists(data.catalog_id))
      return reply.code(400).send({ error: "catalog_id: нет такой позиции каталога" });
    if (!id || !updateRow(db, "license_purchase", "id", id, data)) return reply.code(404).send({ error: "не найдено" });
    return get(id);
  });

  app.delete<{ Params: { id: string } }>("/api/purchases/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id || !db.prepare("DELETE FROM license_purchase WHERE id = ?").run(id).changes)
      return reply.code(404).send({ error: "не найдено" });
    return reply.code(204).send();
  });
}
