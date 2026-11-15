/**
 * Учёт закупок: статус, срок, стоимость, сводка «что скоро истекает и сколько стоит продлить».
 * Статус закупки:
 *   perpetual — бессрочная (valid_until NULL);
 *   active    — действует, до конца > EXPIRING_DAYS;
 *   expiring  — истекает в ближайшие EXPIRING_DAYS дней (пора продлевать);
 *   expired   — срок прошёл (в compliance места уже не считаются).
 * Стоимость = seats × unit_price. «Продление» = стоимость истекающих по текущей цене.
 * Тесты: test/purchases.test.ts
 */
import { all, type DB } from "../db.ts";
import { EXPIRING_DAYS } from "./licenses.ts";
import { byCodeUnit } from "./text.ts";

export type PurchaseStatus = "perpetual" | "active" | "expiring" | "expired";

/**
 * valid_until «YYYY-MM-DD» (включительно) → статус и сколько дней осталось (отрицательно — сколько дней как
 * истекла).
 */
export function purchaseStatus(validUntil: string | null, today = new Date().toISOString().slice(0, 10)) {
  if (!validUntil) return { status: "perpetual" as PurchaseStatus, days_left: null };
  const days = Math.round((Date.parse(validUntil + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86_400_000);
  const status: PurchaseStatus = days < 0 ? "expired" : days <= EXPIRING_DAYS ? "expiring" : "active";
  return { status, days_left: days };
}

export interface PurchaseRow {
  id: number;
  catalog_id: number;
  catalog_name: string;
  seats: number;
  unit_price: number;
  valid_until: string | null;
  contract: string | null;
}

/** Закупка со статусом по сроку действия (purchaseStatus), признаком active и общей стоимостью. */
export function enrich<T extends PurchaseRow>(p: T, today?: string) {
  const s = purchaseStatus(p.valid_until, today);
  return { ...p, ...s, active: s.status !== "expired", total_cost: Math.round(p.seats * p.unit_price * 100) / 100 };
}

const SELECT = `SELECT p.*, c.name AS catalog_name, c.license_kind,
  (SELECT COUNT(DISTINCT i.device_serial) FROM installation i WHERE i.catalog_id = p.catalog_id AND i.is_noise = 0) AS installed
  FROM license_purchase p JOIN software_catalog c ON c.id = p.catalog_id`;

/**
 * `used` — сколько установок «приходится» на этот договор: установки позиции каталога раскладываются по действующим
 * договорам, сначала по ближайшему сроку (истекающий договор заполнен — его надо продлевать), бессрочные последними;
 * остаток сверх всех мест — на последний договор (used > seats = превышение). У просроченных used = 0.
 */
export function allocateUsed<
  T extends {
    id: number;
    catalog_id: number;
    seats: number;
    valid_until: string | null;
    status: PurchaseStatus;
    installed: number;
  },
>(rows: T[]) {
  const used = new Map<number, number>();
  const byCat = new Map<number, T[]>();
  for (const r of rows) (byCat.get(r.catalog_id) ?? byCat.set(r.catalog_id, []).get(r.catalog_id)!).push(r);
  for (const list of byCat.values()) {
    const live = list
      .filter((r) => r.status !== "expired")
      .sort((a, b) =>
        (a.valid_until ?? "9999") < (b.valid_until ?? "9999")
          ? -1
          : (a.valid_until ?? "9999") > (b.valid_until ?? "9999")
            ? 1
            : a.id - b.id,
      );
    let left = list[0]?.installed ?? 0;
    live.forEach((r, i) => {
      const take = i === live.length - 1 ? left : Math.min(left, r.seats);
      used.set(r.id, take);
      left -= take;
    });
  }
  return rows.map((r) => ({ ...r, used: used.get(r.id) ?? 0 }));
}

/** Закупки с занятыми местами и фильтрами по программе, статусу и подстроке (договор, программа). */
export function listPurchases(db: DB, f: { catalog_id?: number | null; status?: string; q?: string }) {
  const needle = f.q?.toLowerCase() ?? ""; // поиск по подстроке в JS — буквальный
  const rows = all<PurchaseRow & { installed: number }>(db, `${SELECT} ORDER BY c.name, p.id`);
  return allocateUsed(rows.map((r) => enrich(r))).filter(
    (r) =>
      (f.catalog_id == null || r.catalog_id === f.catalog_id) &&
      (!f.status || r.status === f.status) &&
      (!needle || r.catalog_name.toLowerCase().includes(needle) || (r.contract ?? "").toLowerCase().includes(needle)),
  );
}

/** Одна закупка в виде для API; undefined — нет такой. */
export function getPurchase(db: DB, id: number) {
  return listPurchases(db, {}).find((p) => p.id === id);
}

/** Сводка для экрана «Закупки» и дашборда. */
export function purchaseSummary(db: DB, expiringDays = EXPIRING_DAYS) {
  const all = listPurchases(db, {}).map((p) =>
    p.status === "active" && p.days_left !== null && p.days_left <= expiringDays
      ? { ...p, status: "expiring" as PurchaseStatus }
      : p,
  );
  const agg = (st: PurchaseStatus) => {
    const list = all.filter((p) => p.status === st);
    return {
      purchases: list.length,
      seats: list.reduce((s, p) => s + p.seats, 0),
      cost: list.reduce((s, p) => s + p.total_cost, 0),
    };
  };
  const live = all.filter((p) => p.status !== "expired");
  const expiringSoon = all
    .filter((p) => p.status === "expiring")
    .sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0));
  return {
    expiring_days: expiringDays,
    total: {
      purchases: all.length,
      seats: all.reduce((s, p) => s + p.seats, 0),
      cost: all.reduce((s, p) => s + p.total_cost, 0),
    },
    seats_active: live.reduce((s, p) => s + p.seats, 0), // куплено мест по действующим договорам
    seats_used: live.reduce((s, p) => s + Math.min(p.used, p.seats), 0), // из них занято
    active_cost: live.reduce((s, p) => s + p.total_cost, 0), // во что обошлись действующие лицензии
    by_status: {
      perpetual: agg("perpetual"),
      active: agg("active"),
      expiring: agg("expiring"),
      expired: agg("expired"),
    },
    renewal_cost: agg("expiring").cost, // продлить всё, что истекает, по текущим ценам
    next_expiry:
      expiringSoon[0]?.valid_until ??
      all
        .filter((p) => p.status === "active")
        .map((p) => p.valid_until!)
        .sort(byCodeUnit)[0] ??
      null,
    expiring: expiringSoon.map(
      ({ id, catalog_name, seats, unit_price, total_cost, valid_until, days_left, contract }) => ({
        id,
        catalog_name,
        seats,
        unit_price,
        total_cost,
        valid_until,
        days_left,
        contract,
      }),
    ),
  };
}
