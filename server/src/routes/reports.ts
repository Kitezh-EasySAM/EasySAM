/**
 * Выгрузки и отчёты. Логика: services/reports.ts. Контракт: docs/API.md §20
 *   GET /api/export/agents.xlsx         — все агенты (ПК): сводка, установленное ПО, лицензии ПК
 *   GET /api/reports/management.xlsx    — отчёт для руководства (Excel)
 *   GET /api/reports/management.pdf     — отчёт для руководства (PDF, A4)
 * Доступно и роли «только просмотр» (это чтение).
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import type { DB } from "../db.ts";
import { agentsWorkbook, managementPdf, managementWorkbook, reportFileName } from "../services/reports.ts";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const send = (reply: FastifyReply, buf: Buffer, type: string, name: string) =>
  reply
    .header("content-type", type)
    .header("content-disposition", `attachment; filename="${name}"`)
    .header("cache-control", "no-store")
    .send(buf);

export function reportRoutes(app: FastifyInstance, db: DB) {
  app.get("/api/export/agents.xlsx", async (_req, reply) =>
    send(reply, await agentsWorkbook(db), XLSX, reportFileName("easysam-agents", "xlsx")),
  );
  app.get("/api/reports/management.xlsx", async (_req, reply) =>
    send(reply, await managementWorkbook(db), XLSX, reportFileName("easysam-report", "xlsx")),
  );
  app.get("/api/reports/management.pdf", async (_req, reply) =>
    send(reply, await managementPdf(db), "application/pdf", reportFileName("easysam-report", "pdf")),
  );
}
