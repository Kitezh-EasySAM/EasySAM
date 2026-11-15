/**
 * Хранилище ключей и раздача на ПК (лицензии стороннего ПО, напр. КриптоПро CSP).
 *  - license_pool: купленные ключи (полный ключ хранится, наружу — только маска; к агенту — только в команде);
 *  - agent_command: «установи ключ из пула» для конкретного ПК; агент забирает (GET /api/agent/commands),
 *    применяет штатной утилитой продукта и отчитывается; после успеха сразу шлёт новый снимок лицензий.
 *  - обзор по продуктам: на скольких ПК, статусы, ближайшее истечение, какие ключи и сколько мест занято.
 * Безопасность: типы команд — белый список (только set_license для известных продуктов), произвольные команды
 *   невозможны.
 * Тесты: test/licensePool.test.ts
 */
import { all, one, tx, type DB } from "../db.ts";
import { APP_TITLES, computeRisks, EXPIRING_DAYS, poolSeats, type LicenseRow } from "./licenses.ts";
import { maskKey, maskKeys, PRODUCTS } from "./licenseProducts.ts";
import { byCodeUnit } from "./text.ts";
export { keyTail, maskKey, maskKeys, PRODUCTS, productList, type ProductDef } from "./licenseProducts.ts";
export { poolSeats };

export interface PoolRow {
  id: number;
  product: string;
  title: string;
  license_key: string;
  key_tail: string;
  seats: number;
  valid_until: string | null;
  license_type: string | null;
  note: string | null;
  created_at: string;
}

/** Сколько ПК сейчас используют ключ (по partial_key от агентов) + сколько команд на установку ещё в пути. */
function usage(db: DB, p: PoolRow) {
  const used = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT device_serial) c FROM device_license WHERE application = ? AND UPPER(partial_key) = ?",
      )
      .get(p.product, p.key_tail) as { c: number }
  ).c;
  const pending = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT device_serial) c FROM agent_command WHERE pool_id = ? AND status IN ('pending','sent')",
      )
      .get(p.id) as { c: number }
  ).c;
  return { used, pending, free: Math.max(0, p.seats - used - pending) };
}

/** Ключ хранилища для ответа API: без полного ключа, с маской и занятыми местами. */
export const publicPool = (db: DB, p: PoolRow) => {
  const { license_key, ...rest } = p;
  return { ...rest, key_masked: maskKey(license_key), ...usage(db, p) };
};

/** Ключи хранилища (все или одного продукта) в виде для API. */
export function listPool(db: DB, product?: string) {
  return all<PoolRow>(
    db,
    "SELECT * FROM license_pool WHERE (? IS NULL OR product = ?) ORDER BY product, valid_until IS NULL, valid_until",
    product ?? null,
    product ?? null,
  ).map((p) => publicPool(db, p));
}

export class DeployError extends Error {}

/**
 * Поставить в очередь установку ключа на ПК. target: список серийников или подборка
 * «expired» / «expiring» / «trial» / «unlicensed» / «without» (ПК, где продукт стоит, а лицензии нет).
 */
export function deploy(
  db: DB,
  poolId: number,
  target: string[] | "expired" | "expiring" | "trial" | "unlicensed" | "without",
) {
  return tx(db, () => {
    const p = one<PoolRow>(db, "SELECT * FROM license_pool WHERE id = ?", poolId);
    if (!p) throw new DeployError("ключ не найден");
    if (!PRODUCTS[p.product]?.deploy)
      throw new DeployError(
        `агент не умеет ставить ключи «${PRODUCTS[p.product]?.title ?? p.product}» — этот ключ только для учёта мест`,
      );
    if (p.valid_until && p.valid_until < new Date().toISOString().slice(0, 10))
      throw new DeployError(`срок ключа истёк ${p.valid_until}`);
    let serials: string[];
    if (Array.isArray(target)) serials = [...new Set(target)];
    else {
      const rows = all<LicenseRow>(db, "SELECT * FROM device_license WHERE application = ?", p.product);
      const risks = computeRisks(rows, Date.now(), poolSeats(db));
      const want = { expired: "expired", expiring: "expiring", trial: "trial", unlicensed: "unlicensed" } as const;
      serials =
        target === "without"
          ? [] // заполняется ниже по факту установки продукта
          : [...new Set(rows.filter((r) => risks.get(r)!.includes(want[target])).map((r) => r.device_serial))];
      if (target === "without") {
        const has = new Set(rows.map((r) => r.device_serial));
        const names = PRODUCTS[p.product]?.installNames ?? [p.product];
        serials = (
          db
            .prepare(
              `SELECT DISTINCT i.device_serial, ulower(i.raw_name) AS n FROM installation i WHERE i.is_noise = 0`,
            )
            .all() as { device_serial: string; n: string }[]
        )
          .filter((r) => names.some((x) => r.n.includes(x)))
          .map((r) => r.device_serial)
          .filter((s) => !has.has(s));
      }
    }
    // уже стоит этот ключ — не дублируем
    const already = new Set(
      (
        db
          .prepare("SELECT device_serial FROM device_license WHERE application = ? AND UPPER(partial_key) = ?")
          .all(p.product, p.key_tail) as { device_serial: string }[]
      ).map((r) => r.device_serial),
    );
    const inFlight = new Set(
      (
        db
          .prepare("SELECT device_serial FROM agent_command WHERE pool_id = ? AND status IN ('pending','sent')")
          .all(p.id) as { device_serial: string }[]
      ).map((r) => r.device_serial),
    );
    const unknown = serials.filter((s) => !db.prepare("SELECT 1 FROM device WHERE serial_number = ?").get(s));
    if (unknown.length) throw new DeployError(`неизвестные ПК: ${unknown.slice(0, 5).join(", ")}`);
    const todo = serials.filter((s) => !already.has(s) && !inFlight.has(s));
    const { free } = usage(db, p);
    if (todo.length > free)
      throw new DeployError(`не хватает мест: нужно ${todo.length}, свободно ${free} из ${p.seats}`);
    const ins = db.prepare(
      "INSERT INTO agent_command (device_serial, type, product, pool_id) VALUES (?, 'set_license', ?, ?)",
    );
    const ids = todo.map((s) => Number(ins.run(s, p.product, p.id).lastInsertRowid));
    return {
      queued: ids.length,
      skipped_already: serials.filter((s) => already.has(s) || inFlight.has(s)).length,
      command_ids: ids,
    };
  });
}

/**
 * Для агента: невыполненные команды ПК (помечаются sent). Здесь — единственное место, где наружу уходит полный ключ.
 */
/**
 * Задания агенту. withKeys=false (агент пришёл с общим INGEST_TOKEN, а не с токеном своего ПК) — задания с ключом
 * лицензии не выдаются: обладатель общего токена мог бы назваться чужим серийником и забрать ключ.
 */
export function takeCommands(db: DB, serial: string, withKeys = true) {
  return tx(db, () => {
    const rows = db
      .prepare(
        `SELECT c.id, c.type, c.product, p.license_key FROM agent_command c LEFT JOIN license_pool p ON p.id = c.pool_id
       WHERE c.device_serial = ? AND c.status IN ('pending','sent') AND (? = 1 OR c.pool_id IS NULL) ORDER BY c.id LIMIT 10`,
      )
      .all(serial, withKeys ? 1 : 0) as { id: number; type: string; product: string; license_key: string | null }[];
    const mark = db.prepare("UPDATE agent_command SET status = 'sent', updated_at = datetime('now') WHERE id = ?");
    for (const r of rows) mark.run(r.id);
    // ключ есть только у set_license; у snapshot — null
    return rows.map((r) => ({ id: r.id, type: r.type, product: r.product, key: r.license_key }));
  });
}

/** Закрыть задание агента результатом; false — задания нет, оно чужое или уже закрыто. */
export function finishCommand(db: DB, serial: string, id: number, ok: boolean, output: string) {
  const r = db
    .prepare(
      "UPDATE agent_command SET status = ?, result = ?, updated_at = datetime('now') WHERE id = ? AND device_serial = ? AND status IN ('pending','sent')",
    )
    .run(ok ? "done" : "failed", maskKeys(output).slice(0, 2000), id, serial);
  return Number(r.changes) > 0;
}

/** Журнал заданий агентам (до 500, новые первыми) с фильтром по статусу и ПК. */
export function listCommands(db: DB, f: { status?: string; device?: string }) {
  return db
    .prepare(
      `SELECT c.id, c.device_serial, d.hostname, c.type, c.product, c.pool_id, p.title AS pool_title, c.status, c.result, c.created_at, c.updated_at
     FROM agent_command c LEFT JOIN device d ON d.serial_number = c.device_serial LEFT JOIN license_pool p ON p.id = c.pool_id
     WHERE (? IS NULL OR c.status = ?) AND (? IS NULL OR c.device_serial = ?) ORDER BY c.id DESC LIMIT 500`,
    )
    .all(f.status ?? null, f.status ?? null, f.device ?? null, f.device ?? null);
}

/** Обзор «сколько ПК, когда истекает» по каждому продукту (windows, office, cryptopro_csp…). */
export function productOverview(db: DB) {
  const rows = all<LicenseRow>(db, "SELECT * FROM device_license");
  const risks = computeRisks(rows, Date.now(), poolSeats(db));
  const byApp = new Map<string, LicenseRow[]>();
  for (const r of rows) (byApp.get(r.application) ?? byApp.set(r.application, []).get(r.application)!).push(r);
  return [...byApp]
    .map(([app, list]) => {
      const devs = (pred: (r: LicenseRow) => boolean) => new Set(list.filter(pred).map((r) => r.device_serial)).size;
      const has = (risk: string) => (r: LicenseRow) => risks.get(r)!.includes(risk as never);
      const future = list
        .map((r) => r.expires_at)
        .filter((d): d is string => !!d && d >= new Date().toISOString().slice(0, 19).replace("T", " "))
        .sort(byCodeUnit);
      const keys = new Map<string, Set<string>>();
      for (const r of list)
        if (r.partial_key)
          (keys.get(r.partial_key) ?? keys.set(r.partial_key, new Set()).get(r.partial_key)!).add(r.device_serial);
      const seats = poolSeats(db);
      return {
        application: app,
        title: PRODUCTS[app]?.title ?? (app === "office" ? "Microsoft Office" : (APP_TITLES[app] ?? app)),
        can_deploy: !!PRODUCTS[app]?.deploy,
        devices: devs(() => true),
        licensed: devs((r) => r.status === "licensed"),
        trial: devs(has("trial")),
        expired: devs(has("expired")),
        expiring: devs(has("expiring")),
        unlicensed: devs(has("unlicensed")),
        key_reuse: devs(has("key_reuse")),
        next_expiry: future[0] ?? null,
        expiring_days: EXPIRING_DAYS,
        keys: [...keys]
          .map(([tail, s]) => ({ partial_key: tail, devices: s.size, seats: seats.get(`${app}|${tail}`) ?? null }))
          .sort((a, b) => b.devices - a.devices)
          .slice(0, 20),
        pool: app in PRODUCTS ? listPool(db, app) : [],
      };
    })
    .sort((a, b) => b.devices - a.devices);
}
