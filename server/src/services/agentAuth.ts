/**
 * Токены агентов на каждый ПК.
 *  - enroll_key: ключ регистрации (кладёт установщик install-sam-agent.ps1 в реестр ПК); ограничение по числу и сроку;
 *  - POST /api/agent/enroll {enroll_key, serial_number, hostname, os} → собственный токен ПК (прежние токены ПК
 *   отзываются);
 *  - дальше агент ходит с X-Agent-Token; сервер проверяет, что токен выдан ИМЕННО этому серийнику (routes/auth.ts).
 * На сервере хранятся только sha256 ключей и токенов; открытый текст показывается один раз при создании/выдаче.
 *  - готовый sam-agent.json (agentConfigFile): адрес сервера + ключ регистрации; общий INGEST_TOKEN туда НЕ кладём —
 *    агент по ключу получит собственный токен ПК. Ключ в открытом виде есть только в этом файле (на сервере — sha256).
 * Тесты: test/agentAuth.test.ts
 */
import { createHash, randomBytes } from "node:crypto";
import type { DB } from "../db.ts";
import { tx } from "../db.ts";

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const random = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

export class EnrollError extends Error {}

/** Новый ключ регистрации агентов; открытый ключ возвращается только здесь, в БД — sha256. */
export function createEnrollKey(db: DB, o: { title: string; max_uses?: number | null; expires_at?: string | null }) {
  const key = random("sek");
  const id = Number(
    db
      .prepare("INSERT INTO enroll_key (title, key_hash, key_tail, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(o.title, sha256(key), key.slice(-4), o.max_uses ?? null, o.expires_at ?? null).lastInsertRowid,
  );
  return { id, key }; // открытый ключ — только здесь
}

/** Все ключи регистрации с маской ключа и числом выданных по нему активных токенов ПК. */
export function listEnrollKeys(db: DB) {
  return (
    db
      .prepare(
        `SELECT id, title, key_tail, max_uses, uses, expires_at, revoked, created_at,
       (SELECT COUNT(*) FROM agent_token t WHERE t.enroll_key_id = k.id AND t.revoked = 0) AS active_tokens
     FROM enroll_key k ORDER BY id DESC`,
      )
      .all() as ({ id: number; key_tail: string; revoked: number } & Record<string, unknown>)[]
  ).map((r) => ({ ...r, revoked: !!r.revoked, key_masked: `sek_…${r.key_tail}` }));
}

/** Регистрация агента: проверить ключ, выдать токен ПК (старые токены этого ПК отозвать). */
export function enroll(
  db: DB,
  o: { enroll_key: string; serial_number: string; hostname?: string | null; os?: string | null },
) {
  return tx(db, () => {
    const k = db.prepare("SELECT * FROM enroll_key WHERE key_hash = ?").get(sha256(o.enroll_key)) as
      { id: number; max_uses: number | null; uses: number; expires_at: string | null; revoked: number } | undefined;
    if (!k || k.revoked) throw new EnrollError("ключ регистрации не найден или отозван");
    if (k.expires_at && k.expires_at < new Date().toISOString().slice(0, 10))
      throw new EnrollError(`срок ключа регистрации истёк ${k.expires_at}`);
    if (k.max_uses != null && k.uses >= k.max_uses)
      throw new EnrollError(`ключ регистрации исчерпан (${k.uses} из ${k.max_uses})`);
    db.prepare(
      `INSERT INTO device (serial_number, hostname, os, last_seen, agent_last_seen) VALUES (?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(serial_number) DO UPDATE SET hostname = COALESCE(excluded.hostname, hostname), os = COALESCE(excluded.os, os),
         agent_last_seen = datetime('now')`,
    ).run(o.serial_number, o.hostname ?? null, o.os ?? null);
    db.prepare("UPDATE agent_token SET revoked = 1 WHERE device_serial = ? AND revoked = 0").run(o.serial_number);
    const token = random("sat");
    db.prepare("INSERT INTO agent_token (device_serial, token_hash, enroll_key_id) VALUES (?, ?, ?)").run(
      o.serial_number,
      sha256(token),
      k.id,
    );
    db.prepare("UPDATE enroll_key SET uses = uses + 1 WHERE id = ?").run(k.id);
    return { token };
  });
}

/** Чей это токен? null — неизвестен или отозван. last_used_at обновляется не чаще раза в минуту. */
export function deviceOfToken(db: DB, token: string): string | null {
  const r = db
    .prepare("SELECT id, device_serial, last_used_at FROM agent_token WHERE token_hash = ? AND revoked = 0")
    .get(sha256(token)) as { id: number; device_serial: string; last_used_at: string | null } | undefined;
  if (!r) return null;
  db.prepare(
    "UPDATE agent_token SET last_used_at = datetime('now') WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-60 seconds'))",
  ).run(r.id);
  return r.device_serial;
}

/** Токены ПК (без самих токенов): чей, когда выдан и использован, отозван ли. */
export function listAgentTokens(db: DB) {
  return (
    db
      .prepare(
        `SELECT t.id, t.device_serial, d.hostname, t.created_at, t.last_used_at, t.revoked, k.title AS enroll_key_title
     FROM agent_token t LEFT JOIN device d ON d.serial_number = t.device_serial LEFT JOIN enroll_key k ON k.id = t.enroll_key_id
     ORDER BY t.revoked, t.id DESC`,
      )
      .all() as Record<string, unknown>[]
  ).map((r) => ({ ...r, revoked: !!r.revoked }));
}

/** Адрес сервера для агента: http(s)://хост[:порт] без пути и хвостового «/». Иначе null. */
export function normalizeServerUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(raw.trim()) ? raw.trim() : `http://${raw.trim()}`);
  } catch {
    return null;
  }
  if (
    !/^https?:$/.test(u.protocol) ||
    !u.hostname ||
    u.username ||
    u.password ||
    (u.pathname !== "/" && u.pathname !== "") ||
    u.search ||
    u.hash
  )
    return null;
  return `${u.protocol}//${u.host}`;
}

/** Содержимое sam-agent.json (кладётся рядом с sam-agent.exe). «_»-ключи — комментарии, агент их игнорирует. */
export function agentConfigFile(o: {
  server: string;
  enrollKey: string;
  title: string;
  expiresAt?: string | null;
  maxUses?: number | null;
  interval?: number;
  usageInterval?: number;
}) {
  const limits = [
    o.maxUses ? `до ${o.maxUses} ПК` : "без ограничения числа ПК",
    o.expiresAt ? `зарегистрироваться до ${o.expiresAt}` : "без срока",
  ].join(", ");
  return {
    _описание: `Настройки агента EasySAM («${o.title}»). Положите рядом с sam-agent.exe и запустите его двойным щелчком от администратора — встанет служба.`,
    server: o.server,
    _server: "адрес сервера EasySAM; проверка с ПК: открыть в браузере <server>/api/health",
    enroll_key: o.enrollKey,
    _enroll_key:
      `ключ регистрации (${limits}). При первом запуске агент получит по нему собственный токен ПК и сохранит его ` +
      "в реестре. Ключ — секрет: не публикуйте файл; отозвать — «Агенты» → «Установка агента».",
    interval: o.interval ?? 60,
    _interval: "секунд между проверками установленного ПО",
    usage_interval: o.usageInterval ?? 300,
    _usage_interval: "как часто отправлять сводку запущенных программ, секунд",
  };
}
