/**
 * Коннектор: POST /api/ingest/agent (полный снимок), POST /api/ingest/events (инкремент), файл /api/ingest/csv,
 * ручной ввод /api/ingest/manual. Контракт: docs/API.md §6
 */
import multipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db.ts";
import { applyEvents, applySnapshot, touchAgent } from "../services/ingest.ts";
import { replaceDeviceLicenses } from "../services/licenses.ts";
import { lastEventId, publish, publishNewInstallEvents } from "../services/stream.ts";
import { parseUpload, toDevices, UploadError } from "../services/tabular.ts";

const nullableStr = z.string().nullish();
const item = z.object({
  name: z.string().min(1),
  publisher: nullableStr,
  version: nullableStr,
  install_date: nullableStr,
  install_location: z.string().max(1000).nullish(),
});
const device = { serial_number: z.string().min(1), hostname: nullableStr, os: nullableStr };
const license = z.object({
  application: z.string().min(1).max(50),
  product: z.string().min(1).max(300),
  description: nullableStr,
  channel: nullableStr,
  status: z.string().min(1).max(50),
  status_code: z.number().int().nullish(),
  // только последние символы ключа: полный ключ сервер не принимает и не хранит
  partial_key: z.string().max(5).nullish(),
  expires_at: nullableStr,
});
// licenses отсутствует = агент старой версии / не собирал → лицензии ПК не трогаем; [] = на ПК нет лицензий
const snapshotBody = z.object({
  ...device,
  items: z.array(item).max(20000),
  licenses: z.array(license).max(200).optional(),
});
const eventsBody = z.object({
  ...device,
  events: z
    .array(
      z.object({
        type: z.enum(["installed", "removed", "updated"]),
        name: z.string().min(1),
        publisher: nullableStr,
        old_version: nullableStr,
        new_version: nullableStr,
        at: z.string().optional(),
      }),
    )
    .max(5000),
});

const manualBody = z.strictObject({
  serial_number: z.string().trim().min(1).max(200),
  hostname: z.string().trim().max(200).nullish(),
  name: z.string().trim().min(1).max(500),
  publisher: z.string().trim().max(300).nullish(),
  version: z.string().trim().max(100).nullish(),
});

export async function ingestRoutes(app: FastifyInstance, db: DB) {
  await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024, files: 1 } });

  app.post("/api/ingest/agent", async (req, reply) => {
    const p = snapshotBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: z.prettifyError(p.error) });
    const before = lastEventId(db);
    const { licenses, ...snap } = p.data;
    const s = applySnapshot(db, { ...snap, source: "agent" });
    touchAgent(db, snap.serial_number);
    publishNewInstallEvents(db, before);
    const alerts = licenses ? replaceDeviceLicenses(db, snap.serial_number, licenses) : [];
    const hostname = (
      db.prepare("SELECT hostname FROM device WHERE serial_number = ?").get(snap.serial_number) as {
        hostname: string | null;
      }
    ).hostname;
    for (const a of alerts)
      publish({
        event: "license",
        data: {
          device_serial: a.device_serial,
          hostname,
          application: a.application,
          product: a.product,
          risk: a.risk,
          alert: { level: a.level, reason: a.risk, text: a.text },
        },
      });
    publish({
      event: "ingest",
      data: { batch_id: s.batchId, source: "agent", devices: 1, rows_total: s.rowsTotal, events: s.events },
    });
    return {
      batch_id: s.batchId,
      rows_total: s.rowsTotal,
      rows_noise: s.rowsNoise,
      rows_matched: s.rowsMatched,
      rows_unknown: s.rowsUnknown,
      events: s.events,
      licenses: licenses?.length ?? null,
      license_alerts: alerts.length,
    };
  });

  app.post("/api/ingest/events", async (req, reply) => {
    const p = eventsBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: z.prettifyError(p.error) });
    const { events, ...dev } = p.data;
    // ПК неизвестен (база пересоздана / агент начал с событий): без полного снимка состав ПО будет неполным
    if (!db.prepare("SELECT 1 FROM device WHERE serial_number = ?").get(dev.serial_number))
      return reply.code(409).send({ error: "устройство неизвестно серверу: нужен полный снимок", need_snapshot: true });
    const before = lastEventId(db);
    const r = applyEvents(db, dev, events);
    touchAgent(db, dev.serial_number);
    publishNewInstallEvents(db, before);
    return r;
  });

  app.post("/api/ingest/csv", async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "нужен multipart-файл в поле file" });
    try {
      const buf = await file.toBuffer();
      const { devices, rowsInFile } = toDevices(await parseUpload(file.filename, buf));
      const before = lastEventId(db);
      const batchId = Number(db.prepare("INSERT INTO ingest_batch (source) VALUES ('csv')").run().lastInsertRowid);
      let events = 0;
      for (const d of devices) events += applySnapshot(db, { ...d, source: "csv", batchId }).events;
      const b = db.prepare("SELECT * FROM ingest_batch WHERE id = ?").get(batchId) as Record<string, number>;
      publishNewInstallEvents(db, before); // поштучно только если событий немного
      publish({
        event: "ingest",
        data: { batch_id: batchId, source: "csv", devices: devices.length, rows_total: b.rows_total, events },
      });
      return {
        batch_id: batchId,
        rows_in_file: rowsInFile,
        rows_total: b.rows_total,
        rows_noise: b.rows_noise,
        rows_matched: b.rows_matched,
        rows_unknown: b.rows_unknown,
        devices: devices.length,
        events,
      };
    } catch (e) {
      if (e instanceof UploadError) return reply.code(400).send({ error: e.message });
      if ((e as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE")
        return reply.code(413).send({ error: "файл больше 100 МБ" });
      throw e;
    }
  });

  // ручной ввод одной установки (интерфейс, admin): тот же конвейер, что у событий агента; ПК создаётся, если его не
  // было
  app.post("/api/ingest/manual", async (req, reply) => {
    const p = manualBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: z.prettifyError(p.error) });
    const { name, publisher, version, ...dev } = p.data;
    const before = lastEventId(db);
    applyEvents(db, dev, [{ type: "installed", name, publisher: publisher || null, new_version: version || null }]);
    publishNewInstallEvents(db, before);
    const row = db
      .prepare(
        `SELECT i.catalog_id, c.name AS catalog_name, i.is_noise FROM installation i LEFT JOIN software_catalog c ON c.id = i.catalog_id
       WHERE i.device_serial = ? AND i.raw_name = ? ORDER BY i.id DESC LIMIT 1`,
      )
      .get(dev.serial_number, name) as { catalog_id: number | null; catalog_name: string | null; is_noise: number };
    return reply.code(201).send({
      serial_number: dev.serial_number,
      catalog_id: row.catalog_id,
      catalog_name: row.catalog_name,
      is_noise: !!row.is_noise,
    });
  });

  app.get("/api/ingest/batches", async () =>
    db
      .prepare(
        "SELECT id, source, created_at, rows_total, rows_noise, rows_matched, rows_unknown FROM ingest_batch ORDER BY id DESC LIMIT 100",
      )
      .all(),
  );
}
