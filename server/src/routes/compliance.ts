/**
 * GET /api/compliance — баланс «куплено vs установлено» + сводка. Расчёт: services/report.ts (+ формулы
 * services/compliance.ts)
 */
import type { FastifyInstance } from "fastify";
import type { DB } from "../db.ts";
import { complianceReport } from "../services/report.ts";

export function complianceRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/compliance", async () => complianceReport(db));
}
