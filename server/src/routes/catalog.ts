/** Каталог ПО и справочник лицензионных соглашений (CRUD). Контракт: docs/API.md §3–4 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { likeContains, type DB } from "../db.ts";
import { rematchUnknown } from "../services/ingest.ts";
import { versionMatch } from "../services/normalize.ts";
import { body, bools, insertRow, kindEnum, parseId, statusEnum, updateRow } from "./util.ts";

const SELECT_CATALOG = `
  SELECT c.*, lt.name AS license_type_name,
    (SELECT COUNT(DISTINCT i.device_serial) FROM installation i WHERE i.catalog_id = c.id AND i.is_noise = 0) AS installed,
    COALESCE((SELECT SUM(p.seats) FROM license_purchase p WHERE p.catalog_id = c.id
              AND (p.valid_until IS NULL OR p.valid_until >= date('now'))), 0) AS seats
  FROM software_catalog c LEFT JOIN license_type lt ON lt.id = c.license_type_id`;

const catalogFields = {
  name: z.string().trim().min(1).max(300),
  vendor: z.string().max(200).nullish(),
  purpose: z.string().max(2000).nullish(),
  registry_section: z.string().max(200).nullish(),
  registry_class: z.string().max(200).nullish(),
  internal_status: statusEnum,
  min_version: z.string().max(50).nullish(),
  license_type_id: z.number().int().positive().nullish(),
  license_kind: kindEnum,
  in_ru_registry: z.boolean().nullish(),
  list_price: z.number().min(0).nullish(),
};
const catalogCreate = z.strictObject({
  ...catalogFields,
  internal_status: statusEnum.default("current"),
  license_kind: kindEnum.default("open_source"),
});
const catalogPatch = z.strictObject(catalogFields).partial();

const ltFields = {
  name: z.string().trim().min(1).max(300),
  kind: kindEnum,
  commercial_use: z.boolean().nullish(),
  copyleft: z.boolean().nullish(),
  notes: z.string().max(5000).nullish(),
};
const ltCreate = z.strictObject({ ...ltFields, kind: kindEnum.default("open_source") });
const ltPatch = z.strictObject(ltFields).partial();

export function catalogRoutes(app: FastifyInstance, db: DB) {
  const getItem = (id: number) => {
    const r = db.prepare(`${SELECT_CATALOG} WHERE c.id = ?`).get(id) as Record<string, unknown> | undefined;
    return r && bools(r, ["in_ru_registry"]);
  };

  app.get<{ Querystring: { q?: string; status?: string; kind?: string; limit?: string; offset?: string } }>(
    "/api/catalog",
    async (req) => {
      const { q, status, kind } = req.query;
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const like = likeContains(q);
      const where = `WHERE (? IS NULL OR ulower(c.name) LIKE ? ESCAPE '\\' OR ulower(c.vendor) LIKE ? ESCAPE '\\')
      AND (? IS NULL OR c.internal_status = ?) AND (? IS NULL OR c.license_kind = ?)`;
      const params = [like, like, like, status ?? null, status ?? null, kind ?? null, kind ?? null];
      const total = (db.prepare(`SELECT COUNT(*) c FROM software_catalog c ${where}`).get(...params) as { c: number })
        .c;
      const items = (
        db
          .prepare(`${SELECT_CATALOG} ${where} ORDER BY installed DESC, c.name LIMIT ? OFFSET ?`)
          .all(...params, limit, offset) as Record<string, unknown>[]
      ).map((r) => bools(r, ["in_ru_registry"]));
      return { total, items };
    },
  );

  // карточка ПО: у кого стоит (ответ на «у кого стоит нелицензионный Photoshop») + закупки
  app.get<{ Params: { id: string } }>("/api/catalog/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const item = id && getItem(id);
    if (!item) return reply.code(404).send({ error: "не найдено" });
    const devices = (
      db
        .prepare(
          `SELECT i.device_serial, d.id AS device_id, d.hostname, e.full_name AS employee, e.department, e.active AS employee_active,
         i.raw_name, i.raw_version, i.last_used
       FROM installation i JOIN device d ON d.serial_number = i.device_serial LEFT JOIN employee e ON e.id = d.employee_id
       WHERE i.catalog_id = ? AND i.is_noise = 0 ORDER BY d.serial_number, i.raw_name`,
        )
        .all(id) as Record<string, unknown>[]
    ).map((r) => ({
      ...bools(r, ["employee_active"]),
      // соответствие нужной версии позиции: older/newer → жёлтая строка на борде
      version_match: versionMatch(
        r.raw_version as string | null,
        (item as { min_version?: string | null }).min_version ?? null,
      ),
    }));
    const purchases = db
      .prepare(
        `SELECT *, (valid_until IS NULL OR valid_until >= date('now')) AS active FROM license_purchase WHERE catalog_id = ? ORDER BY id`,
      )
      .all(id)
      .map((r) => bools(r as Record<string, unknown>, ["active"]));
    return { ...item, devices, purchases };
  });

  app.post("/api/catalog", async (req, reply) => {
    const data = body(catalogCreate, req.body, reply);
    if (!data) return;
    const id = insertRow(db, "software_catalog", data);
    rematchUnknown(db); // новое имя может «забрать» нераспознанные установки
    return reply.code(201).send(getItem(id));
  });

  app.patch<{ Params: { id: string } }>("/api/catalog/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const data = body(catalogPatch, req.body, reply);
    if (!data) return;
    if (!id || !updateRow(db, "software_catalog", "id", id, data)) return reply.code(404).send({ error: "не найдено" });
    if (data.name) rematchUnknown(db);
    return getItem(id);
  });

  app.delete<{ Params: { id: string } }>("/api/catalog/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id || !getItem(id)) return reply.code(404).send({ error: "не найдено" });
    const inst = (db.prepare("SELECT COUNT(*) c FROM installation WHERE catalog_id = ?").get(id) as { c: number }).c;
    const pur = (db.prepare("SELECT COUNT(*) c FROM license_purchase WHERE catalog_id = ?").get(id) as { c: number }).c;
    if (inst || pur)
      return reply.code(409).send({
        error: `нельзя удалить: установок ${inst}, закупок ${pur}. Смените статус на «запрещён» или «устарел»`,
      });
    db.prepare("DELETE FROM alias WHERE catalog_id = ?").run(id);
    db.prepare("DELETE FROM software_catalog WHERE id = ?").run(id);
    return reply.code(204).send();
  });

  // ---- справочник лицензионных соглашений
  const getLt = (id: number) => {
    const r = db
      .prepare(
        `SELECT lt.*, (SELECT COUNT(*) FROM software_catalog c WHERE c.license_type_id = lt.id) AS software_count
       FROM license_type lt WHERE lt.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    return r && bools(r, ["commercial_use", "copyleft"]);
  };

  app.get("/api/license-types", async () =>
    (
      db
        .prepare(
          `SELECT lt.*, (SELECT COUNT(*) FROM software_catalog c WHERE c.license_type_id = lt.id) AS software_count
       FROM license_type lt ORDER BY software_count DESC, lt.name`,
        )
        .all() as Record<string, unknown>[]
    ).map((r) => bools(r, ["commercial_use", "copyleft"])),
  );

  app.post("/api/license-types", async (req, reply) => {
    const data = body(ltCreate, req.body, reply);
    if (!data) return;
    return reply.code(201).send(getLt(insertRow(db, "license_type", data)));
  });

  app.patch<{ Params: { id: string } }>("/api/license-types/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const data = body(ltPatch, req.body, reply);
    if (!data) return;
    if (!id || !updateRow(db, "license_type", "id", id, data)) return reply.code(404).send({ error: "не найдено" });
    return getLt(id);
  });

  app.delete<{ Params: { id: string } }>("/api/license-types/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const lt = id && getLt(id);
    if (!lt) return reply.code(404).send({ error: "не найдено" });
    if (lt.software_count)
      return reply.code(409).send({ error: `используется в ${lt.software_count} позициях каталога` });
    db.prepare("DELETE FROM license_type WHERE id = ?").run(id);
    return reply.code(204).send();
  });
}
