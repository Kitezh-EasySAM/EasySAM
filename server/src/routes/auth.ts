/**
 * Авторизация — единственное место. Контракт: docs/API.md «Доступ».
 *  - агентские адреса (/api/ingest/agent|events|usage, /api/agent/*):
 *      X-Agent-Token — токен ПК (services/agentAuth.ts): запрос принимается только для СВОЕГО серийника;
 *      X-Ingest-Token — общий токен (разработка/демо): работает, только если задан INGEST_TOKEN; отключается
 *   REQUIRE_DEVICE_TOKEN=1; ключи лицензий по нему НЕ выдаются;
 *    /api/agent/enroll — без токена (проверяется ключ регистрации в теле);
 *  - интерфейс (всё остальное /api/*): cookie-сессия `sam_session` после POST /api/auth/login (services/users.ts),
 *    или для скриптов `Authorization: Bearer <ADMIN_TOKEN>` (права admin);
 *    роль viewer — только чтение (+ вопросы ассистенту, выход, смена своего пароля);
 *    выданный пароль (must_change_password) — до смены доступны только /api/auth/me|password|logout (403
 *   change_password);
 *    изменяющие запросы с чужим Origin отклоняются (защита от CSRF вдобавок к SameSite=Strict);
 *  - AUTH=off — интерфейс открыт (только тесты/локальная отладка);
 *  - /api/health, /api/auth/login и CORS preflight (OPTIONS) — всегда открыты.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { deviceOfToken } from "../services/agentAuth.ts";
import { sessionUser, type User } from "../services/users.ts";

const AGENT_PATH = /^\/api\/(ingest\/(agent|events|usage)|agent\/)/;
const OPEN = new Set(["/api/health", "/api/agent/enroll", "/api/auth/login"]);
const VIEWER_WRITE = new Set(["/api/ai/chat", "/api/auth/logout", "/api/auth/password"]);
export const SESSION_COOKIE = "sam_session";

export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};
/**
 * CSP страниц фронта: всё только со своего адреса (скрипты, шрифты из бандла, SSE /api/stream);
 * img data:/blob: — встроенный значок вкладки и скачивание файлов; style 'unsafe-inline' — вычисляемые style
 * (ширина полоски покрытия, колонки сетки), классами их не заменить.
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
const header = (req: FastifyRequest, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function safeEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== "string" || !b) return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function setSessionCookie(reply: FastifyReply, token: string | null) {
  const attrs = ["Path=/", "HttpOnly", "SameSite=Strict", ...(config.cookieSecure ? ["Secure"] : [])];
  reply.header(
    "set-cookie",
    token
      ? `${SESSION_COOKIE}=${token}; ${attrs.join("; ")}; Max-Age=${Math.round(config.sessionHours * 3600)}`
      : `${SESSION_COOKIE}=; ${attrs.join("; ")}; Max-Age=0`,
  );
}

/** Серийник, к которому привязан токен ПК (нет — общий токен, без привязки). */
const boundSerial = new WeakMap<FastifyRequest, string>();
export const deviceTokenSerial = (req: FastifyRequest) => boundSerial.get(req) ?? null;

/** Кто делает запрос интерфейса (null — агент или открытый адрес). */
const users = new WeakMap<FastifyRequest, User>();
export const currentUser = (req: FastifyRequest) => users.get(req) ?? null;
const SYSTEM: User = {
  id: 0,
  login: "system",
  name: "Скрипт (ADMIN_TOKEN)",
  role: "admin",
  active: true,
  must_change_password: false,
  created_at: "",
  last_login_at: null,
};
const WITH_TEMP_PASSWORD = new Set(["/api/auth/me", "/api/auth/password", "/api/auth/logout"]);
const OPEN_MODE: User = { ...SYSTEM, name: "Без входа (AUTH=off)" };

const sameOrigin = (req: FastifyRequest) => {
  const origin = header(req, "origin");
  if (!origin) return true; // не браузер или same-origin GET
  try {
    return new URL(origin).host === header(req, "host");
  } catch {
    return false;
  }
};

export function authHooks(app: FastifyInstance, db: DB) {
  app.addHook("onRequest", async (req, reply) => {
    // решение — по НАЙДЕННОМУ маршруту (шаблону), а не по сырому адресу: «/api/agent/../users» не выдать за агентский
    const raw = req.url.split("?")[0];
    const path = req.routeOptions?.url ?? raw;
    if (req.method === "OPTIONS" || !(path.startsWith("/api/") || raw.startsWith("/api/"))) return;
    if (path === "/api/auth/login" && req.method === "POST" && !sameOrigin(req))
      return reply.code(403).send({ error: "вход с чужого сайта отклонён" }); // login CSRF: не дать «залогинить» жертву в чужой аккаунт
    if (OPEN.has(path)) return;
    if (AGENT_PATH.test(path)) {
      const deviceToken = header(req, "x-agent-token");
      if (deviceToken) {
        const serial = deviceOfToken(db, deviceToken);
        if (!serial)
          return reply
            .code(401)
            .send({ error: "токен агента не найден или отозван — нужна повторная регистрация", reenroll: true });
        boundSerial.set(req, serial);
        return;
      }
      if (
        !config.requireDeviceToken &&
        config.ingestToken &&
        safeEqual(header(req, "x-ingest-token"), config.ingestToken)
      )
        return;
      return reply
        .code(401)
        .send({ error: config.requireDeviceToken ? "нужен токен ПК (X-Agent-Token)" : "bad token" });
    }

    let user: User | null = null;
    let viaCookie = false;
    if (config.authMode === "off") user = OPEN_MODE;
    else {
      const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
      if (bearer && config.adminToken && safeEqual(bearer, config.adminToken)) user = SYSTEM;
      else {
        user = sessionUser(db, readCookie(req, SESSION_COOKIE));
        viaCookie = !!user;
      }
    }
    if (!user) return reply.code(401).send({ error: "нужно войти", login: true });
    const write = req.method !== "GET" && req.method !== "HEAD";
    if (write && viaCookie && !sameOrigin(req))
      return reply.code(403).send({ error: "запрос с чужого сайта отклонён" });
    if (user.must_change_password && !WITH_TEMP_PASSWORD.has(path))
      return reply.code(403).send({ error: "сначала смените временный пароль", change_password: true });
    if (write && user.role !== "admin" && !VIEWER_WRITE.has(path))
      return reply.code(403).send({ error: "недостаточно прав: только просмотр" });
    users.set(req, user);
  });

  // токен ПК → данные только своего ПК (серийник в теле или ?serial=)
  app.addHook("preHandler", async (req, reply) => {
    const serial = boundSerial.get(req);
    if (!serial) return;
    const claimed =
      (req.body as { serial_number?: unknown } | undefined)?.serial_number ??
      new URLSearchParams(req.url.split("?")[1] ?? "").get("serial");
    if (claimed !== serial) return reply.code(403).send({ error: "токен выдан другому ПК" });
  });

  // заголовки безопасности: у API и у страниц фронта (index.html, assets/), у страниц ещё CSP
  app.addHook("onSend", async (req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    if (req.url.startsWith("/api/")) {
      if (!reply.getHeader("cache-control")) reply.header("cache-control", "no-store");
    } else if (!req.url.startsWith("/downloads/")) reply.header("content-security-policy", PAGE_CSP);
    return payload;
  });
}
