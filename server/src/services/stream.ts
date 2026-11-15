/**
 * Живые уведомления (SSE): шина в памяти процесса + обогащение событий установок и алерты.
 * Источники: routes/ingest.ts (новые install_event, итоги загрузок, риски лицензий), хук на изменяющие запросы
 *   (changed).
 * Транспорт: routes/stream.ts. Контракт сообщений: docs/API.md §8. Тесты: test/stream.test.ts
 *
 * Алерты (то, что фронт показывает красным тостом сразу):
 *  - установлено/обновлено ПО со статусом «запрещено»;
 *  - установка платного ПО довела число ПК выше купленных мест.
 */
import { EventEmitter } from "node:events";
import type { DB } from "../db.ts";

export type StreamMessage =
  | { event: "install"; id: number; data: InstallMessage }
  | {
      event: "ingest";
      data: { batch_id: number | null; source: string; devices: number; rows_total: number; events: number };
    }
  | { event: "changed"; data: { method: string; path: string } }
  | { event: "license"; data: LicenseMessage }
  | { event: "process"; data: ProcessMessage }
  | { event: "agent"; data: { device_serial: string } }
  | {
      event: "command";
      data: { id: number; device_serial: string; hostname: string | null; product: string; ok: boolean; text: string };
    };

/** Запущено запрещённое ПО (red) или неустановленное/переносное ПО (yellow). */
export interface ProcessMessage {
  device_serial: string;
  hostname: string | null;
  exe: string;
  path: string | null;
  catalog_name: string | null;
  alert: { level: "red" | "yellow"; reason: string; text: string };
}

/** Новый риск по лицензии Windows/Office (services/licenses.ts): не активировано, истекает, один ключ на многих ПК. */
export interface LicenseMessage {
  device_serial: string;
  hostname: string | null;
  application: string;
  product: string;
  risk: string;
  alert: { level: "red" | "yellow"; reason: string; text: string };
}

export interface InstallMessage {
  id: number;
  device_serial: string;
  hostname: string | null;
  employee: string | null;
  type: "installed" | "removed" | "updated";
  raw_name: string;
  raw_publisher: string | null;
  old_version: string | null;
  new_version: string | null;
  at: string;
  catalog_id: number | null;
  catalog_name: string | null;
  internal_status: string | null;
  license_kind: string | null;
  alert: { level: "red"; reason: "forbidden" | "over_license"; text: string } | null;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);
/** Отправить сообщение всем подписчикам живой ленты. */
export const publish = (m: StreamMessage) => bus.emit("msg", m);
/** Подписка на живую ленту; возвращает отписку. */
export function subscribe(fn: (m: StreamMessage) => void): () => void {
  bus.on("msg", fn);
  return () => bus.off("msg", fn);
}

/** Сердцебиение агента → SSE «agent», не чаще раза в 10 с на ПК: борда сама обновляет статус «в сети». */
const lastAgentTouch = new Map<string, number>();
/** Сообщить ленте, что агент ПК вышел на связь (не чаще раза в 10 с на ПК). */
export function publishAgentTouch(serial: string) {
  const now = Date.now();
  if (now - (lastAgentTouch.get(serial) ?? 0) < 10_000) return;
  lastAgentTouch.set(serial, now);
  publish({ event: "agent", data: { device_serial: serial } });
}

/** Номер последнего события установки — точка отсчёта для publishNewInstallEvents. */
export const lastEventId = (db: DB) =>
  (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM install_event").get() as { m: number }).m;

const LICENSABLE = new Set(["commercial", "shareware", "trial"]);

/** install_event с id > afterId (по возрастанию), обогащённые каталогом, владельцем и алертом. */
export function installMessagesSince(db: DB, afterId: number, limit = 500): InstallMessage[] {
  const rows = db
    .prepare(
      `SELECT ev.id, ev.device_serial, d.hostname, e.full_name AS employee, ev.type, ev.raw_name, ev.raw_publisher,
       ev.old_version, ev.new_version, ev.at, ev.catalog_id, c.name AS catalog_name, c.internal_status, c.license_kind
     FROM install_event ev LEFT JOIN device d ON d.serial_number = ev.device_serial
     LEFT JOIN employee e ON e.id = d.employee_id LEFT JOIN software_catalog c ON c.id = ev.catalog_id
     WHERE ev.id > ? ORDER BY ev.id LIMIT ?`,
    )
    .all(afterId, limit) as Omit<InstallMessage, "alert">[];
  return rows.map((r) => ({ ...r, alert: alertFor(db, r) }));
}

function alertFor(db: DB, r: Omit<InstallMessage, "alert">): InstallMessage["alert"] {
  if (r.type === "removed" || !r.catalog_id) return null;
  const where = r.hostname ?? r.device_serial;
  const who = r.employee ? ` (${r.employee})` : "";
  if (r.internal_status === "forbidden")
    return { level: "red", reason: "forbidden", text: `Запрещённое ПО «${r.catalog_name}» на ${where}${who}` };
  // «превышение» — только если эта установка заняла НОВОЕ место (на ПК не было другой установки этой позиции)
  const sameOnDevice = (
    db
      .prepare("SELECT COUNT(*) c FROM installation WHERE device_serial = ? AND catalog_id = ? AND is_noise = 0")
      .get(r.device_serial, r.catalog_id) as { c: number }
  ).c;
  if (r.type === "installed" && r.license_kind && LICENSABLE.has(r.license_kind) && sameOnDevice <= 1) {
    const { installed, seats } = db
      .prepare(
        `SELECT (SELECT COUNT(DISTINCT device_serial) FROM installation WHERE catalog_id = ? AND is_noise = 0) AS installed,
         COALESCE((SELECT SUM(seats) FROM license_purchase WHERE catalog_id = ?
                   AND (valid_until IS NULL OR valid_until >= date('now'))), 0) AS seats`,
      )
      .get(r.catalog_id, r.catalog_id) as { installed: number; seats: number };
    if (installed > seats)
      return {
        level: "red",
        reason: "over_license",
        text: `Превышение лицензий «${r.catalog_name}»: ${installed} ПК при ${seats} купленных (новая установка на ${where}${who})`,
      };
  }
  return null;
}

/** Опубликовать всё, что появилось в install_event после beforeId. Для массовых загрузок — только итог. */
// 50: первый снимок агента по ПК, ранее загруженному из CSV, даёт ~100+ «removed» — это не лента, а массовая сверка
export function publishNewInstallEvents(db: DB, beforeId: number, max = 50): number {
  const msgs = installMessagesSince(db, beforeId, max + 1);
  if (msgs.length > max) return 0; // массовая загрузка: поштучно не шлём, хватит сообщения ingest
  for (const m of msgs) publish({ event: "install", id: m.id, data: m });
  return msgs.length;
}
