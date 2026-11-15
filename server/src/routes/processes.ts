/**
 * POST /api/ingest/usage (агент, токен) и GET /api/processes. Логика: services/processes.ts. Контракт: docs/API.md
 * §11
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db.ts";
import { applyUsage, listProcesses } from "../services/processes.ts";
import { touchAgent } from "../services/ingest.ts";
import { publish } from "../services/stream.ts";

const s = z.string().max(1000).nullish();
const usageBody = z.object({
  serial_number: z.string().min(1),
  hostname: s,
  os: s,
  processes: z
    .array(
      z.object({
        exe: z.string().min(1).max(300),
        path: s,
        product_name: s,
        company: s,
        file_version: s,
        first_seen: z.string().min(1),
        last_seen: z.string().min(1),
        samples: z.number().int().min(0).optional(),
      }),
    )
    .max(2000),
});

export function processRoutes(app: FastifyInstance, db: DB) {
  app.post("/api/ingest/usage", async (req, reply) => {
    const p = usageBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: z.prettifyError(p.error) });
    const dev = db.prepare("SELECT hostname FROM device WHERE serial_number = ?").get(p.data.serial_number) as
      { hostname: string | null } | undefined;
    if (!dev)
      return reply.code(409).send({ error: "устройство неизвестно серверу: нужен полный снимок", need_snapshot: true });
    const r = applyUsage(db, p.data.serial_number, p.data.processes);
    touchAgent(db, p.data.serial_number);
    for (const a of r.alerts)
      publish({
        event: "process",
        data: {
          device_serial: p.data.serial_number,
          hostname: dev.hostname,
          exe: a.exe,
          path: a.path,
          catalog_name: a.catalog_name,
          alert: { level: a.level, reason: a.reason, text: a.text },
        },
      });
    return { accepted: r.accepted, alerts: r.alerts.length };
  });

  app.get<{ Querystring: { device?: string; filter?: string; limit?: string } }>("/api/processes", async (req) =>
    listProcesses(db, {
      device: req.query.device,
      filter: req.query.filter,
      limit: Math.min(Math.max(Number(req.query.limit) || 500, 1), 5000),
    }),
  );
}
