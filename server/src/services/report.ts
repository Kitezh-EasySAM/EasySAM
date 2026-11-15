/**
 * Отчёт compliance из БД: «куплено vs установлено», штраф, простой, «зомби». Формулы — services/compliance.ts (чистые).
 * Используют: GET /api/compliance, уведомления (колокольчик), перенос лицензий, ИИ-ассистент.
 */
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { compute, summarize, type CatalogInfo, type InternalStatus, type LicenseKind } from "./compliance.ts";
import { isOutdated } from "./normalize.ts";

export type ReportRow = ReturnType<typeof complianceReport>["rows"][number];

/** «Куплено vs установлено» по каталогу из БД (формулы — compliance.ts), ответ в snake_case. */
export function complianceReport(db: DB) {
  const seats = new Map<number, { seats: number; price: number }>();
  for (const r of db
    .prepare(
      `SELECT catalog_id, SUM(seats) AS seats, SUM(seats * unit_price) AS cost FROM license_purchase
     WHERE valid_until IS NULL OR valid_until >= date('now') GROUP BY catalog_id`,
    )
    .all() as { catalog_id: number; seats: number; cost: number }[])
    seats.set(r.catalog_id, { seats: r.seats, price: r.seats ? r.cost / r.seats : 0 });

  const installed = new Map<number, number>();
  for (const r of db
    .prepare(
      `SELECT catalog_id, COUNT(DISTINCT device_serial) AS n FROM installation
     WHERE catalog_id IS NOT NULL AND is_noise = 0 GROUP BY catalog_id`,
    )
    .all() as { catalog_id: number; n: number }[])
    installed.set(r.catalog_id, r.n);

  const outdated = new Map<number, Set<string>>();
  for (const r of db
    .prepare(
      `SELECT i.catalog_id, i.device_serial, i.raw_version, c.min_version FROM installation i
     JOIN software_catalog c ON c.id = i.catalog_id WHERE i.is_noise = 0 AND c.min_version IS NOT NULL`,
    )
    .all() as { catalog_id: number; device_serial: string; raw_version: string | null; min_version: string }[])
    if (isOutdated(r.raw_version, r.min_version)) {
      if (!outdated.has(r.catalog_id)) outdated.set(r.catalog_id, new Set());
      outdated.get(r.catalog_id)!.add(r.device_serial);
    }

  const zombie = new Map<number, number>();
  for (const r of db
    .prepare(
      `SELECT i.catalog_id, COUNT(DISTINCT i.device_serial) AS n FROM installation i
     JOIN device d ON d.serial_number = i.device_serial LEFT JOIN employee e ON e.id = d.employee_id
     WHERE i.catalog_id IS NOT NULL AND i.is_noise = 0
       AND ((i.last_used IS NOT NULL AND i.last_used < datetime('now', ?)) OR e.active = 0
         -- ни разу не запускали: за процессами этого ПК наблюдаем дольше STALE_DAYS, а программа так и не появилась
         OR (i.last_used IS NULL AND (SELECT MIN(p.first_seen) FROM process_usage p WHERE p.device_serial = i.device_serial) < datetime('now', ?)))
     GROUP BY i.catalog_id`,
    )
    .all(`-${config.staleDays} days`, `-${config.staleDays} days`) as { catalog_id: number; n: number }[])
    zombie.set(r.catalog_id, r.n);

  // факт использования: на скольких ПК программу запускали за последние 30 дней (процессы от агента)
  const running = new Map<number, number>();
  for (const r of db
    .prepare(
      `SELECT catalog_id, COUNT(DISTINCT device_serial) AS n FROM process_usage
     WHERE catalog_id IS NOT NULL AND last_seen >= datetime('now', '-30 days') GROUP BY catalog_id`,
    )
    .all() as { catalog_id: number; n: number }[])
    running.set(r.catalog_id, r.n);

  const items: CatalogInfo[] = (
    db.prepare("SELECT id, name, license_kind, internal_status, list_price FROM software_catalog").all() as {
      id: number;
      name: string;
      license_kind: LicenseKind;
      internal_status: InternalStatus;
      list_price: number | null;
    }[]
  ).map((c) => ({
    id: c.id,
    name: c.name,
    licenseKind: c.license_kind,
    internalStatus: c.internal_status,
    seats: seats.get(c.id)?.seats ?? 0,
    unitPrice: seats.get(c.id)?.price || c.list_price || 0, // цена из закупок, иначе справочная
    installed: installed.get(c.id) ?? 0,
    outdatedInstalled: outdated.get(c.id)?.size ?? 0,
    zombie: zombie.get(c.id) ?? 0,
  }));
  const rows = compute(items);
  const s = summarize(rows);
  // наружу всё в snake_case (единый формат API для фронтенда)
  return {
    summary: {
      total_penalty: s.totalPenalty,
      total_waste: s.totalWaste,
      total_reclaimable: s.totalReclaimable,
      zombie: s.zombie,
      red: s.red,
      yellow: s.yellow,
      green: s.green,
      products: s.products,
    },
    rows: rows.map((r) => ({
      catalog_id: r.catalogId,
      name: r.name,
      license_kind: r.licenseKind,
      seats: r.seats,
      installed: r.installed,
      deficit: r.deficit,
      idle: r.idle,
      penalty: r.penalty,
      waste: r.waste,
      zombie: r.zombie,
      reclaimable: r.reclaimable,
      running: running.get(r.catalogId) ?? 0,
      status: r.status,
      severity: r.severity,
    })),
  };
}
