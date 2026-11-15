/**
 * `make demo`: добавить ДЕМО-данные (в материалах их нет) в БД с реальными данными (config.dbPath):
 * ОС ПК, закупки и цены, сотрудники, «последний запуск», статусы и нужные версии каталога, лицензии Windows/Office с
 *   ПК, КриптоПро.
 * Те же данные при каждом запуске (фиксированное зерно). Повторно на ту же БД не применяется. Описание — seed.ts
 *   (seedDemo).
 * Docker: docker compose exec sam node src/scripts/run-demo.ts
 */
import { config } from "../config.ts";
import { openDb } from "../db.ts";
import { seedDemo } from "./seed.ts";

const db = openDb(config.dbPath);
try {
  console.log(`демо-данные → ${config.dbPath}`, seedDemo(db));
  console.log("готово; интерфейс обновится сам (или перезагрузите страницу)");
} catch (e) {
  console.error(`✖ ${(e as Error).message}`);
  process.exit(1);
}
