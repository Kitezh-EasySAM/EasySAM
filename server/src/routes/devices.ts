/**
 * Устройства и лента событий (экран «Устройства»: карточка ПК → список ПО). Адрес ПК: /api/devices/:id (числовой id)
 * или серийник.
 */
import type { FastifyInstance } from "fastify";
import { likeContains, type DB } from "../db.ts";
import { config } from "../config.ts";
import { AGENT_STATUS_SQL } from "../services/ingest.ts";
import { listLicenseKeys } from "../services/licenses.ts";
import { listProcesses } from "../services/processes.ts";
import { listDevices } from "../services/devices.ts";
import { versionMatch } from "../services/normalize.ts";

/** Серийник по ключу из адреса: числовой id (/agents/12) или сам серийник (старые ссылки, агенты). */
export function deviceSerialOf(db: DB, key: string): string | null {
  if (/^\d{1,9}$/.test(key)) {
    const r = db.prepare("SELECT serial_number FROM device WHERE id = ?").get(Number(key)) as
      { serial_number: string } | undefined;
    if (r) return r.serial_number;
  }
  const r = db.prepare("SELECT serial_number FROM device WHERE serial_number = ?").get(key) as
    { serial_number: string } | undefined;
  return r?.serial_number ?? null;
}

export function deviceRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/devices", async () => listDevices(db));

  app.get<{ Params: { key: string } }>("/api/devices/:key", async (req, reply) => {
    const serial = deviceSerialOf(db, req.params.key);
    if (!serial) return reply.code(404).send({ error: "не найдено" });
    const dev = db
      .prepare(
        `SELECT d.*, ${AGENT_STATUS_SQL(config.agentOnlineSeconds)} AS agent_status, e.full_name AS employee, e.department
       FROM device d LEFT JOIN employee e ON e.id = d.employee_id WHERE d.serial_number = ?`,
      )
      .get(serial);
    const software = (
      db
        .prepare(
          `SELECT i.id, i.raw_name, i.raw_publisher, i.raw_version, i.is_noise, i.match_method, i.catalog_id, i.last_used, c.name AS catalog_name,
         c.internal_status, c.license_kind, c.min_version FROM installation i LEFT JOIN software_catalog c ON c.id = i.catalog_id
       WHERE i.device_serial = ? ORDER BY i.is_noise, i.raw_name`,
        )
        .all(serial) as Record<string, unknown>[]
    ).map((r) => ({
      ...r,
      // соответствие нужной версии каталога: older/newer → жёлтая строка на борде
      version_match: versionMatch(r.raw_version as string | null, r.min_version as string | null),
    }));
    const events = db
      .prepare(
        `SELECT ev.*, c.name AS catalog_name, c.internal_status FROM install_event ev
       LEFT JOIN software_catalog c ON c.id = ev.catalog_id
       WHERE ev.device_serial = ? ORDER BY ev.at DESC, ev.id DESC LIMIT 200`,
      )
      .all(serial);
    const licenses = listLicenseKeys(db, { device: serial }).items;
    const processes = listProcesses(db, { device: serial }).items;
    return { device: dev, software, events, licenses, processes };
  });

  // «Запросить снимок»: задание агенту отправить полный снимок (программы + лицензии) при следующем опросе
  app.post<{ Params: { key: string } }>("/api/devices/:key/request-snapshot", async (req, reply) => {
    const serial = deviceSerialOf(db, req.params.key);
    if (!serial) return reply.code(404).send({ error: "не найдено" });
    const open = db
      .prepare(
        "SELECT id FROM agent_command WHERE device_serial = ? AND type = 'snapshot' AND status IN ('pending','sent')",
      )
      .get(serial) as { id: number } | undefined;
    if (open) return { command_id: open.id, already_queued: true };
    const id = Number(
      db.prepare("INSERT INTO agent_command (device_serial, type, product) VALUES (?, 'snapshot', 'agent')").run(serial)
        .lastInsertRowid,
    );
    return reply.code(201).send({ command_id: id, already_queued: false });
  });

  // лента событий: ?limit (по умолч. 100, до 2000) &type=installed|removed|updated &days=N &q=текст &problems=1
  // (запрещённое/неопознанное)
  app.get<{ Querystring: { limit?: string; type?: string; days?: string; q?: string; problems?: string } }>(
    "/api/events",
    async (req) => {
      const { type, q, problems } = req.query;
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 2000);
      const days = Number(req.query.days) || 0;
      const like = likeContains(q);
      return db
        .prepare(
          `SELECT ev.*, c.name AS catalog_name, c.internal_status, d.id AS device_id, d.hostname, e.full_name AS employee FROM install_event ev
       LEFT JOIN software_catalog c ON c.id = ev.catalog_id LEFT JOIN device d ON d.serial_number = ev.device_serial
       LEFT JOIN employee e ON e.id = d.employee_id
       WHERE (? IS NULL OR ev.type = ?) AND (? = 0 OR ev.at >= datetime('now', ?))
         AND (? IS NULL OR ulower(ev.raw_name) LIKE ? ESCAPE '\\' OR ulower(d.hostname) LIKE ? ESCAPE '\\' OR ulower(e.full_name) LIKE ? ESCAPE '\\')
         AND (? IS NULL OR c.internal_status = 'forbidden' OR ev.catalog_id IS NULL)
       ORDER BY ev.at DESC, ev.id DESC LIMIT ?`,
        )
        .all(
          type ?? null,
          type ?? null,
          days,
          `-${days} days`,
          like,
          like,
          like,
          like,
          problems === "1" ? 1 : null,
          limit,
        );
    },
  );
}
