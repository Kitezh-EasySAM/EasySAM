/** Общие хелперы роутов: разбор id, валидация zod, UPDATE по разрешённым полям, булевы поля. */
import type { FastifyReply } from "fastify";
import { z } from "zod";
import type { DB } from "../db.ts";

export function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Валидирует тело; при ошибке сам отвечает 400 и возвращает null. */
export function body<T extends z.ZodType>(schema: T, data: unknown, reply: FastifyReply): z.infer<T> | null {
  const p = schema.safeParse(data);
  if (p.success) return p.data;
  reply.code(400).send({ error: z.prettifyError(p.error) });
  return null;
}

type Val = string | number | null;
const toSql = (v: unknown): Val => (typeof v === "boolean" ? (v ? 1 : 0) : ((v as Val) ?? null));

export function insertRow(db: DB, table: string, data: Record<string, unknown>): number {
  const keys = Object.keys(data); // ключи уже прошли strict-схему zod → безопасно подставлять в SQL
  return Number(
    db
      .prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
      .run(...keys.map((k) => toSql(data[k]))).lastInsertRowid,
  );
}

/** UPDATE только переданных полей. Возвращает число изменённых строк. */
export function updateRow(db: DB, table: string, pk: string, id: Val, data: Record<string, unknown>): number {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (!keys.length)
    return Number((db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE ${pk} = ?`).get(id) as { c: number }).c);
  return Number(
    db
      .prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE ${pk} = ?`)
      .run(...keys.map((k) => toSql(data[k])), id).changes,
  );
}

/** 0/1/null из SQLite → true/false/null в JSON. */
export function bools<T extends Record<string, unknown>>(row: T, keys: string[]): T {
  const r: Record<string, unknown> = { ...row };
  for (const k of keys) if (k in r && r[k] !== null) r[k] = !!r[k];
  return r as T;
}

export const kindEnum = z.enum(["open_source", "freeware", "shareware", "trial", "commercial"]);
export const statusEnum = z.enum(["current", "outdated", "forbidden"]);
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "дата в формате YYYY-MM-DD");
