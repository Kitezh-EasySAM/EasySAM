/**
 * GET /api/license-keys — лицензии Windows/Office с ПК и риски. Логика: services/licenses.ts. Контракт: docs/API.md
 * §10
 */
import type { FastifyInstance } from "fastify";
import type { DB } from "../db.ts";
import { listLicenseKeys } from "../services/licenses.ts";

export function licenseKeyRoutes(app: FastifyInstance, db: DB) {
  app.get<{ Querystring: { application?: string; risk?: string } }>("/api/license-keys", async (req) =>
    listLicenseKeys(db, { application: req.query.application, risk: req.query.risk }),
  );
}
