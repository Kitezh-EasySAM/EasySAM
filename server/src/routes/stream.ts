/**
 * GET /api/stream — Server-Sent Events. Сообщения: install (с alert), ingest, changed. Контракт: docs/API.md §8
 * Поддерживает Last-Event-ID: после переподключения досылает пропущенные install-события (до 100).
 * Хук ниже шлёт changed после любого успешного POST/PATCH/DELETE (кроме ingest — там свои сообщения).
 */
import type { FastifyInstance } from "fastify";
import type { DB } from "../db.ts";
import { installMessagesSince, publish, subscribe, type StreamMessage } from "../services/stream.ts";

const HEARTBEAT_MS = 25_000;

export function streamRoutes(app: FastifyInstance, db: DB) {
  // preClose (а не onClose): закрыть стримы ДО ожидания соединений, иначе app.close() висит вечно
  const open = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const end of [...open]) end();
  });

  app.get("/api/stream", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (m: StreamMessage) =>
      res.write(`${"id" in m ? `id: ${m.id}\n` : ""}event: ${m.event}\ndata: ${JSON.stringify(m.data)}\n\n`);
    res.write("retry: 3000\n: connected\n\n");

    const last = Number(req.headers["last-event-id"]);
    if (Number.isInteger(last) && last > 0)
      for (const m of installMessagesSince(db, last, 100)) send({ event: "install", id: m.id, data: m });

    const unsubscribe = subscribe(send);
    const hb = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
    const end = () => {
      clearInterval(hb);
      unsubscribe();
      open.delete(end);
      if (!res.writableEnded) res.end();
    };
    open.add(end);
    req.raw.on("close", end);
  });

  app.addHook("onResponse", async (req, reply) => {
    if (!["POST", "PATCH", "DELETE"].includes(req.method) || reply.statusCode >= 400) return;
    const path = req.url.split("?")[0];
    if (
      !path.startsWith("/api/") ||
      path.startsWith("/api/ingest") ||
      path.startsWith("/api/agent/") ||
      path.startsWith("/api/auth/") ||
      path.startsWith("/api/users") ||
      path === "/api/ai/chat" ||
      path === "/api/unmatched/ai-suggest"
    )
      return; // вход/чат данных не меняют
    publish({ event: "changed", data: { method: req.method, path } });
  });
}
