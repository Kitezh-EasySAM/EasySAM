/**
 * Пользователи интерфейса и сессии входа.
 *  - пароль: scrypt с солью (node:crypto), сравнение постоянное по времени;
 *  - сессия: случайный токен в HttpOnly-cookie `sam_session`, в БД — только sha256; срок config.sessionHours;
 *  - роли: admin — всё; viewer — только чтение (и вопросы ассистенту);
 *  - защита от перебора: 5 неудачных входов подряд по паре «логин + IP» (30 — с одного IP) → блок на 5 минут;
 *    по одному логину не блокируем — иначе посторонний запирал бы чужую учётную запись;
 *  - выданный пароль (первый admin, создан или сброшен администратором) — must_change_password: до смены доступны
 *   только
 *    /api/auth/* (проверка — routes/auth.ts);
 * Тесты: test/auth.test.ts
 */
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { sha256 } from "./agentAuth.ts";
import { randomPassword } from "./passwordPolicy.ts";
export {
  checkPasswordStrength,
  loginProblem,
  nameProblem,
  passwordProblems,
  randomPassword,
} from "./passwordPolicy.ts";

export type Role = "admin" | "viewer";
export interface User {
  id: number;
  login: string;
  name: string | null;
  role: Role;
  active: boolean;
  must_change_password: boolean;
  created_at: string;
  last_login_at: string | null;
}

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEYLEN = 32;

/** scrypt-хеш пароля с солью в виде scrypt$соль$хеш. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${scryptSync(password, salt, KEYLEN, SCRYPT).toString("base64")}`;
}

/** Совпадает ли пароль с хешем (сравнение постоянное по времени). */
export function verifyPassword(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64");
  const got = scryptSync(password, Buffer.from(salt, "base64"), want.length, SCRYPT);
  return got.length === want.length && timingSafeEqual(got, want);
}

const toUser = (r: Record<string, unknown>): User => ({
  id: r.id as number,
  login: r.login as string,
  name: (r.name as string | null) ?? null,
  role: r.role as Role,
  active: !!r.active,
  must_change_password: !!r.must_change_password,
  created_at: r.created_at as string,
  last_login_at: (r.last_login_at as string | null) ?? null,
});

/** Все пользователи без хешей паролей. */
export function listUsers(db: DB): User[] {
  return (
    db
      .prepare(
        "SELECT id, login, name, role, active, must_change_password, created_at, last_login_at FROM app_user ORDER BY login",
      )
      .all() as Record<string, unknown>[]
  ).map(toUser);
}
/** Пользователь по id; null — нет такого. */
export function getUser(db: DB, id: number): User | null {
  const r = db
    .prepare(
      "SELECT id, login, name, role, active, must_change_password, created_at, last_login_at FROM app_user WHERE id = ?",
    )
    .get(id) as Record<string, unknown> | undefined;
  return r ? toUser(r) : null;
}

/**
 * mustChange — пароль придумал не сам пользователь (администратор, значение по умолчанию): потребовать смену при
 * входе.
 */
export function createUser(
  db: DB,
  o: { login: string; password: string; name?: string | null; role?: Role; mustChange?: boolean },
): number {
  return Number(
    db
      .prepare("INSERT INTO app_user (login, name, password_hash, role, must_change_password) VALUES (?, ?, ?, ?, ?)")
      .run(o.login.trim(), o.name ?? null, hashPassword(o.password), o.role ?? "viewer", o.mustChange ? 1 : 0)
      .lastInsertRowid,
  );
}

/** Новый пароль; все сессии пользователя завершаются. mustChange — потребовать смену при следующем входе. */
export function setPassword(db: DB, id: number, password: string, mustChange = false) {
  db.prepare("UPDATE app_user SET password_hash = ?, must_change_password = ? WHERE id = ?").run(
    hashPassword(password),
    mustChange ? 1 : 0,
    id,
  );
  db.prepare("DELETE FROM user_session WHERE user_id = ?").run(id); // сменил пароль — выкинуть со всех устройств
}

/** Сколько активных администраторов. */
export const activeAdmins = (db: DB) =>
  (db.prepare("SELECT COUNT(*) c FROM app_user WHERE role = 'admin' AND active = 1").get() as { c: number }).c;

// ---- защита от перебора (в памяти процесса)
const fails = new Map<string, { n: number; until: number }>();
// по паре логин+IP — 5 попыток; по IP — 30 (за прокси у всех один IP: не блокировать весь офис из-за одного)
const LOCK_MS = 5 * 60_000;
const maxFails = (key: string) => (key.startsWith("ip:") ? 30 : 5);
/** Сколько секунд ещё заблокирован вход по ключу (логин+IP или IP); 0 — не заблокирован. */
export function loginLocked(key: string): number {
  const f = fails.get(key);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function noteFail(key: string) {
  const f = fails.get(key) ?? { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= maxFails(key)) {
    f.until = Date.now() + LOCK_MS;
    f.n = 0;
  }
  fails.set(key, f);
  if (fails.size > 10_000) fails.clear(); // не даём раздуть память
}
/** Сбросить счётчики неудачных входов (тесты). */
export const resetLoginFails = () => fails.clear();

// хеш-заглушка: при неизвестном логине всё равно считаем scrypt — время ответа не выдаёт, есть ли такой пользователь
const DUMMY = hashPassword(randomPassword());

/** Вход: проверить логин/пароль, создать сессию. Возвращает открытый токен (только здесь) или null. */
export function login(
  db: DB,
  loginName: string,
  password: string,
  ip: string,
): { token: string; user: User } | { locked: number } | null {
  const keys = [`l:${loginName.trim().toLowerCase()}|${ip}`, `ip:${ip}`];
  const locked = Math.max(...keys.map(loginLocked));
  if (locked) return { locked };
  const r = db.prepare("SELECT * FROM app_user WHERE login = ?").get(loginName.trim()) as
    Record<string, unknown> | undefined;
  const ok = verifyPassword(password, (r?.password_hash as string) ?? DUMMY) && !!r && !!r.active;
  if (!ok || !r) {
    keys.forEach(noteFail);
    return null;
  }
  keys.forEach((k) => fails.delete(k));
  const token = `ss_${randomBytes(32).toString("base64url")}`;
  const expires = new Date(Date.now() + config.sessionHours * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
  db.prepare(
    "INSERT INTO user_session (user_id, token_hash, expires_at, last_seen_at) VALUES (?, ?, ?, datetime('now'))",
  ).run(r.id as number, sha256(token), expires);
  db.prepare("UPDATE app_user SET last_login_at = datetime('now') WHERE id = ?").run(r.id as number);
  db.prepare("DELETE FROM user_session WHERE expires_at < datetime('now')").run();
  return { token, user: getUser(db, r.id as number)! };
}

/** Пользователь по токену сессии (null — нет, истекла, пользователь отключён). */
export function sessionUser(db: DB, token: string | undefined): User | null {
  if (!token || !token.startsWith("ss_")) return null;
  const r = db
    .prepare(
      `SELECT u.id, u.login, u.name, u.role, u.active, u.must_change_password, u.created_at, u.last_login_at, s.id AS sid, s.last_seen_at FROM user_session s
     JOIN app_user u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > datetime('now') AND u.active = 1`,
    )
    .get(sha256(token)) as Record<string, unknown> | undefined;
  if (!r) return null;
  // last_seen — не чаще раза в минуту, чтобы не писать в БД на каждый запрос
  db.prepare(
    "UPDATE user_session SET last_seen_at = datetime('now') WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-1 minute'))",
  ).run(r.sid as number);
  return toUser(r);
}

/** Завершить сессию по токену из cookie. */
export function logout(db: DB, token: string | undefined) {
  if (token) db.prepare("DELETE FROM user_session WHERE token_hash = ?").run(sha256(token));
}

/**
 * Первый запуск: если пользователей нет — создать admin. Пароль из ADMIN_PASSWORD, по умолчанию «admin».
 * В обоих случаях пароль первого входа — временный: система не пустит дальше, пока он не сменён.
 */
export function ensureFirstAdmin(db: DB): { login: string; password: string | null } | null {
  if ((db.prepare("SELECT COUNT(*) c FROM app_user").get() as { c: number }).c) return null;
  createUser(db, {
    login: "admin",
    password: config.adminPassword || "admin",
    name: "Администратор",
    role: "admin",
    mustChange: true,
  });
  return { login: "admin", password: config.adminPassword ? null : "admin" };
}
