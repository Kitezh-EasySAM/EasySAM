/**
 * Перенос лицензий: какие установки платного ПО можно снять (уволенный сотрудник / не запускали > STALE_DAYS)
 * и кому отдать освободившиеся места. Правила; ИИ-ассистент использует этот же расчёт и пересказывает его.
 * Для продукта с нехваткой (установлено > куплено): пары «снять с ПК донора → место получает активный ПК без места».
 * Для продукта без нехватки: доноры = места, которые можно вернуть / не продлевать.
 * Тесты: test/reallocation.test.ts
 */
import { config } from "../config.ts";
import { all, type DB } from "../db.ts";
import { complianceReport } from "./report.ts";

const LICENSABLE = new Set(["commercial", "shareware", "trial"]);

export interface Seat {
  device_serial: string;
  device_id: number;
  hostname: string | null;
  employee: string | null;
  department: string | null;
  last_used: string | null;
  reason?: string;
}
export interface ReallocationItem {
  catalog_id: number;
  name: string;
  seats: number;
  installed: number;
  deficit: number;
  idle: number;
  unit_price: number;
  donors: Seat[]; // откуда можно снять
  moves: { from: Seat; to: Seat }[]; // конкретные переносы (только при нехватке)
  covered: number; // сколько мест нехватки закрываем без закупки
  remaining_deficit: number;
  savings: number; // ₽: не покупать covered мест (при нехватке) или вернуть/не продлевать доноров
  text: string; // готовая фраза для интерфейса и ИИ
}

const daysAgo = (s: string | null) =>
  s ? Math.floor((Date.now() - Date.parse(s.replace(" ", "T") + "Z")) / 86_400_000) : null;

/** Что можно перенести: места у уволенных и неиспользуемые установки → туда, где не хватает лицензий. */
export function reallocation(db: DB) {
  const rep = complianceReport(db);
  const staleBefore = new Date(Date.now() - config.staleDays * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const sql = `SELECT i.device_serial, d.id AS device_id, d.hostname, e.full_name AS employee, e.department,
       e.active AS employee_active, MAX(i.last_used) AS last_used
     FROM installation i JOIN device d ON d.serial_number = i.device_serial LEFT JOIN employee e ON e.id = d.employee_id
     WHERE i.catalog_id = ? AND i.is_noise = 0 GROUP BY i.device_serial`;
  const items: ReallocationItem[] = [];
  for (const r of rep.rows) {
    // запрещённое ПО не «переносят», а удаляют — для него перенос не предлагаем
    if (!LICENSABLE.has(r.license_kind) || r.installed === 0 || r.status === "forbidden") continue;
    const unit = r.deficit
      ? r.penalty / r.deficit
      : r.idle
        ? r.waste / r.idle
        : r.zombie
          ? r.reclaimable / r.zombie
          : 0;
    const installs = all<Seat & { employee_active: number | null }>(db, sql, r.catalog_id);
    const donors: Seat[] = [];
    const active: Seat[] = [];
    for (const { employee_active, ...s } of installs) {
      if (employee_active === 0)
        donors.push({ ...s, reason: `сотрудник уволен${s.employee ? ` (${s.employee})` : ""}` });
      else if (s.last_used && s.last_used < staleBefore)
        donors.push({ ...s, reason: `не запускалась ${daysAgo(s.last_used)} дн.` });
      else active.push(s);
    }
    if (!donors.length && r.deficit === 0) continue;
    // уволенные — первыми, затем самые давние запуски
    donors.sort(
      (a, b) =>
        Number(!a.reason?.startsWith("сотрудник")) - Number(!b.reason?.startsWith("сотрудник")) ||
        (a.last_used ?? "").localeCompare(b.last_used ?? ""),
    );
    // активные — по свежести запуска; первые `seats` считаем «с местом», остальные — без места (получатели).
    // Если все активные помещаются в купленные места, нехватку создают доноры: их достаточно снять, переносить некуда.
    active.sort((a, b) => (b.last_used ?? "").localeCompare(a.last_used ?? ""));
    const covered = Math.min(r.deficit, donors.length);
    const recipients = active.slice(r.seats).slice(0, covered);
    const moves = Array.from({ length: Math.min(covered, recipients.length) }, (_, i) => ({
      from: donors[i],
      to: recipients[i],
    }));
    const savings = Math.round((r.deficit > 0 ? covered : donors.length) * unit);
    const text =
      r.deficit > 0
        ? `${r.name}: не хватает ${r.deficit} лиц. (установлено на ${r.installed} ПК, куплено ${r.seats}). ` +
          (covered
            ? `Можно снять с ${covered} ПК (${donors
                .slice(0, covered)
                .map((d) => d.hostname ?? d.device_serial)
                .join(", ")}) и не покупать ${covered} лиц.`
            : "Снять не с кого — нужна закупка.") +
          (r.deficit - covered > 0 && covered ? ` Докупить: ${r.deficit - covered}.` : "")
        : `${r.name}: не используется на ${donors.length} ПК (${donors
            .slice(0, 3)
            .map((d) => `${d.hostname ?? d.device_serial} — ${d.reason}`)
            .join("; ")}${donors.length > 3 ? "…" : ""}) — места можно вернуть или не продлевать.`;
    items.push({
      catalog_id: r.catalog_id,
      name: r.name,
      seats: r.seats,
      installed: r.installed,
      deficit: r.deficit,
      idle: r.idle,
      unit_price: Math.round(unit),
      donors,
      moves,
      covered,
      remaining_deficit: r.deficit - covered,
      savings,
      text,
    });
  }
  items.sort((a, b) => b.deficit - a.deficit || b.savings - a.savings);
  return {
    stale_days: config.staleDays,
    total_savings: items.reduce((s, i) => s + i.savings, 0),
    total_covered: items.reduce((s, i) => s + i.covered, 0),
    items,
  };
}
