/**
 * `make seed` / `make fresh`: реальные данные из материалов в пустую БД (config.dbPath); `--demo` — сразу и демо
 * (`make fresh-demo`).
 */
import { config } from "../config.ts";
import { openDb } from "../db.ts";
import { seedBase, seedDemo } from "./seed.ts";

const db = openDb(config.dbPath);
console.log("реальные данные из материалов…", await seedBase(db));
if (process.argv.includes("--demo"))
  try {
    console.log("демо-данные (ДЕМО: в материалах их нет)…", seedDemo(db));
  } catch (e) {
    // без выгрузки из материалы/ демо не к чему привязать — сервер всё равно стартует
    console.warn(`[seed] демо пропущено: ${e instanceof Error ? e.message : String(e)}`);
  }
const rows = db
  .prepare(
    `SELECT c.name, c.license_kind, c.internal_status,
     (SELECT COUNT(DISTINCT device_serial) FROM installation i WHERE i.catalog_id = c.id AND i.is_noise = 0) AS installed,
     COALESCE((SELECT SUM(seats) FROM license_purchase p WHERE p.catalog_id = c.id AND (p.valid_until IS NULL OR p.valid_until >= date('now'))), 0) AS seats
   FROM software_catalog c ORDER BY installed DESC LIMIT 15`,
  )
  .all();
console.table(rows);
const b = db
  .prepare("SELECT SUM(rows_total) t, SUM(rows_noise) n, SUM(rows_matched) m, SUM(rows_unknown) u FROM ingest_batch")
  .get() as { t: number; n: number; m: number; u: number };
console.log(`загружено ${b.t ?? 0} уник. строк: шум ${b.n ?? 0}, распознано ${b.m ?? 0}, нераспределено ${b.u ?? 0}`);
