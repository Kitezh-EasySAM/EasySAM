/**
 * SQL от модели — в ОТДЕЛЬНОМ ПРОЦЕССЕ на соединении только для чтения (readOnly), с таймаутом и kill.
 * Зачем: node:sqlite синхронный — тяжёлый запрос («декартово произведение установок», рекурсивный CTE) в основном
 * потоке повесил бы весь сервер. Поток (worker_threads) не годится: terminate() не прерывает SQLite внутри
 * нативного цикла, и запрос крутится вечно. Процесс убивается SIGKILL надёжно.
 * readOnly-соединение надёжнее, чем PRAGMA query_only на общем. Для :memory: (тесты) — на месте с query_only.
 */
import { spawn } from "node:child_process";
import type { DB } from "../db.ts";

const CHILD = `
const { DatabaseSync } = require("node:sqlite");
let sql = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (sql += c));
process.stdin.on("end", () => {
  try {
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    // встроенные lower/upper в SQLite — только ASCII; модель пишет LOWER(department) = 'ит' → подменяем на Unicode
    for (const [n, f] of [["ulower", (s) => s.toLowerCase()], ["lower", (s) => s.toLowerCase()], ["upper", (s) => s.toUpperCase()]])
      db.function(n, { deterministic: true }, (v) => (v == null ? null : f(String(v))));
    process.stdout.write(JSON.stringify({ rows: db.prepare(sql).all() }));
  } catch (e) { process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) })); }
});
`;
const MAX_OUT = 5 * 1024 * 1024;

export class SqlTimeout extends Error {}

/** Выполнить SELECT только на чтение в отдельном процессе; SqlTimeout — дольше timeoutMs. */
export function runReadOnly(db: DB, sql: string, timeoutMs = 5000): Promise<Record<string, unknown>[]> {
  const dbPath = db.location(); // файл ИМЕННО этого соединения (null — :memory:)
  if (!dbPath) {
    db.exec("PRAGMA query_only = ON");
    try {
      return Promise.resolve(db.prepare(sql).all() as Record<string, unknown>[]);
    } catch (e) {
      return Promise.reject(e);
    } finally {
      db.exec("PRAGMA query_only = OFF");
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--max-old-space-size=256", "-e", CHILD, dbPath], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    let out = "",
      done = false;
    const finish = (fn: () => void) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        fn();
      }
    };
    const timer = setTimeout(
      () =>
        finish(() => {
          child.kill("SIGKILL");
          reject(new SqlTimeout(`запрос выполнялся дольше ${timeoutMs / 1000} с — уточните вопрос`));
        }),
      timeoutMs,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      out += c;
      if (out.length > MAX_OUT)
        finish(() => {
          child.kill("SIGKILL");
          reject(new Error("слишком большой результат"));
        });
    });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", () =>
      finish(() => {
        try {
          const m = JSON.parse(out) as { rows?: Record<string, unknown>[]; error?: string };
          if (m.error) reject(new Error(m.error));
          else resolve(m.rows ?? []);
        } catch {
          reject(new Error("запрос не выполнился"));
        }
      }),
    );
    child.stdin.end(sql);
  });
}
