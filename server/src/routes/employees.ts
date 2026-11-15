/** Сотрудники и привязка ПК (PATCH /api/devices/:serial). Контракт: docs/API.md §5 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { likeContains, type DB } from "../db.ts";
import { body, bools, insertRow, parseId, updateRow } from "./util.ts";
import { deviceSerialOf } from "./devices.ts";

const fields = {
  full_name: z.string().trim().min(1).max(200),
  department: z.string().max(200).nullish(),
  active: z.boolean(),
};
const create = z.strictObject({ ...fields, active: z.boolean().default(true) });
const patch = z.strictObject(fields).partial();
const devicePatch = z
  .strictObject({
    employee_id: z.number().int().positive().nullable(),
    hostname: z.string().max(200).nullable(),
  })
  .partial();

export function employeeRoutes(app: FastifyInstance, db: DB) {
  // devices — серийники (как было), device_refs — то же с id и именем ПК для ссылок /agents/:id
  const devicesOf = (id: number) => {
    const refs = db
      .prepare("SELECT id, serial_number, hostname FROM device WHERE employee_id = ? ORDER BY serial_number")
      .all(id) as { id: number; serial_number: string; hostname: string | null }[];
    return { devices: refs.map((d) => d.serial_number), device_refs: refs };
  };
  const withDevices = (r: Record<string, unknown>) => ({
    ...bools(r, ["active"]),
    ...devicesOf(r.id as number),
  });
  const get = (id: number) => {
    const r = db.prepare("SELECT * FROM employee WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r && withDevices(r);
  };

  app.get<{ Querystring: { q?: string; active?: string } }>("/api/employees", async (req) => {
    const like = likeContains(req.query.q);
    const active = req.query.active === undefined ? null : req.query.active === "true" ? 1 : 0;
    return (
      db
        .prepare(
          `SELECT * FROM employee WHERE (? IS NULL OR ulower(full_name) LIKE ? ESCAPE '\\' OR ulower(department) LIKE ? ESCAPE '\\')
         AND (? IS NULL OR active = ?) ORDER BY full_name`,
        )
        .all(like, like, like, active, active) as Record<string, unknown>[]
    ).map(withDevices);
  });

  app.post("/api/employees", async (req, reply) => {
    const data = body(create, req.body, reply);
    if (!data) return;
    return reply.code(201).send(get(insertRow(db, "employee", data)));
  });

  app.patch<{ Params: { id: string } }>("/api/employees/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const data = body(patch, req.body, reply);
    if (!data) return;
    if (!id || !updateRow(db, "employee", "id", id, data)) return reply.code(404).send({ error: "не найдено" });
    return get(id);
  });

  app.delete<{ Params: { id: string } }>("/api/employees/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    if (!id || !get(id)) return reply.code(404).send({ error: "не найдено" });
    db.prepare("UPDATE device SET employee_id = NULL WHERE employee_id = ?").run(id); // ПК остаются, просто без владельца
    db.prepare("DELETE FROM employee WHERE id = ?").run(id);
    return reply.code(204).send();
  });

  app.patch<{ Params: { key: string } }>("/api/devices/:key", async (req, reply) => {
    const data = body(devicePatch, req.body, reply);
    if (!data) return;
    const serial = deviceSerialOf(db, req.params.key);
    if (!serial) return reply.code(404).send({ error: "не найдено" });
    if (data.employee_id && !get(data.employee_id))
      return reply.code(400).send({ error: "employee_id: нет такого сотрудника" });
    updateRow(db, "device", "serial_number", serial, data);
    return db.prepare("SELECT * FROM device WHERE serial_number = ?").get(serial);
  });
}
