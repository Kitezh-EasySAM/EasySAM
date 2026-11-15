/**
 * Лицензии Windows/Office с ПК (от агента): хранение и риски. Тесты: test/licenses.test.ts
 * Риски строки (может быть несколько):
 *  - unlicensed — статус unlicensed/notification (не активировано / не подлинное)            → red
 *  - expired    — expires_at уже прошла                                                       → red
 *  - key_reuse  — Windows/Office: тот же Retail/OEM-ключ на ≥2 ПК; стороннее ПО (КриптоПро…): ключ на большем
 *                 числе ПК, чем мест в хранилище (license_pool), а если ключа там нет — на ≥2 ПК             → red
 *  - grace      — льготный период (активация ещё не выполнена)                                → yellow
 *  - trial      — пробная/демо-лицензия (status = trial)                                       → yellow
 *  - expiring   — expires_at в ближайшие EXPIRING_DAYS дней (KMS не продлевается, кончается триал) → yellow
 * Volume-ключи (GVLK/KMS, MAK) одинаковы у многих ПК по замыслу — для key_reuse не считаются.
 * Корпоративные ключи антивирусов (KES, Dr.Web) — тоже один на сотни ПК: key_reuse только если в хранилище
 * есть этот ключ с числом мест и ПК больше, чем мест; без записи в хранилище — не тревожим.
 */
import { all, tx, type DB } from "../db.ts";

export const EXPIRING_DAYS = 30;
export type Risk = "unlicensed" | "expired" | "key_reuse" | "grace" | "expiring" | "trial";
const RED: ReadonlySet<Risk> = new Set(["unlicensed", "expired", "key_reuse"]);

export interface LicenseIn {
  application: string;
  product: string;
  description?: string | null;
  channel?: string | null;
  partial_key?: string | null;
  status: string;
  status_code?: number | null;
  expires_at?: string | null;
}
export interface LicenseRow extends LicenseIn {
  id?: number;
  device_serial: string;
}

/** Канал, где один ключ = одна установка (переиспользование = нарушение). */
export const isPersonalChannel = (ch?: string | null) => !!ch && /^(retail|oem)/i.test(ch.trim());

/** SQLite-дата «YYYY-MM-DD HH:MM:SS» (UTC) → мс. */
const ms = (s: string) => Date.parse(s.replace(" ", "T") + "Z");

const isMsApp = (a: string) => a === "windows" || a === "office";
/** Продукты, у которых один ключ по замыслу стоит на многих ПК (лимит мест знает только хранилище/консоль вендора). */
export const SHARED_KEY_APPS: ReadonlySet<string> = new Set(["kaspersky_kes", "drweb"]);
/** Названия продуктов лицензий с ПК (application → для людей). */
export const APP_TITLES: Record<string, string> = {
  windows: "Windows",
  office: "Office",
  cryptopro_csp: "КриптоПро CSP",
  kaspersky_kes: "Kaspersky Endpoint Security",
  nanocad: "nanoCAD",
  "1c_enterprise": "1С:Предприятие",
  drweb: "Dr.Web",
};
/** Ключ, который считаем на «переиспользование»: у Windows/Office — Retail/OEM, у стороннего ПО — любой. */
const countsForReuse = (r: LicenseRow) =>
  !!r.partial_key && (isMsApp(r.application) ? isPersonalChannel(r.channel) : true);

/** Места по ключам из хранилища: `${product}|${хвост}` → seats. */
export function poolSeats(db: DB): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of db.prepare("SELECT product, key_tail, seats FROM license_pool").all() as {
    product: string;
    key_tail: string;
    seats: number;
  }[])
    m.set(`${p.product}|${p.key_tail}`, (m.get(`${p.product}|${p.key_tail}`) ?? 0) + p.seats);
  return m;
}

/** Риски для набора строк (key_reuse считается по всему набору; seats — места ключей из хранилища). */
export function computeRisks(
  rows: LicenseRow[],
  now = Date.now(),
  seats: Map<string, number> = new Map(),
): Map<LicenseRow, Risk[]> {
  const devicesByKey = new Map<string, Set<string>>();
  for (const r of rows)
    if (countsForReuse(r)) {
      const k = `${r.application}|${r.partial_key}`;
      if (!devicesByKey.has(k)) devicesByKey.set(k, new Set());
      devicesByKey.get(k)!.add(r.device_serial);
    }
  const out = new Map<LicenseRow, Risk[]>();
  for (const r of rows) {
    const risks: Risk[] = [];
    if (r.status === "unlicensed" || r.status === "notification") risks.push("unlicensed");
    if (r.status === "grace") risks.push("grace");
    if (r.status === "trial") risks.push("trial");
    if (r.status === "expired") risks.push("expired");
    if (r.expires_at) {
      const t = ms(r.expires_at);
      if (!Number.isNaN(t)) {
        if (t < now) {
          if (!risks.includes("expired")) risks.push("expired");
        } else if (t - now <= EXPIRING_DAYS * 86_400_000) risks.push("expiring");
      }
    }
    if (countsForReuse(r)) {
      const k = `${r.application}|${r.partial_key}`;
      const used = devicesByKey.get(k)?.size ?? 0;
      const pool = seats.get(`${r.application}|${r.partial_key!.toUpperCase()}`);
      const limit = isMsApp(r.application) ? 1 : SHARED_KEY_APPS.has(r.application) ? (pool ?? Infinity) : (pool ?? 1);
      if (used > limit) risks.push("key_reuse");
    }
    out.set(r, risks);
  }
  return out;
}

export type Severity = "red" | "yellow" | "green";
const ORDER: Record<Severity, number> = { red: 0, yellow: 1, green: 2 };
/** Цвет строки по самому серьёзному риску лицензии. */
export const severityOf = (risks: Risk[]): Severity =>
  risks.some((r) => RED.has(r)) ? "red" : risks.length ? "yellow" : "green";

const appName = (a: string) => APP_TITLES[a] ?? "Лицензия";

/** Текст тревоги по риску лицензии ПК для ленты и колокольчика. */
export function riskText(
  r: LicenseRow & { hostname?: string | null; employee?: string | null },
  risk: Risk,
  reuseCount = 0,
  seats?: number,
): string {
  const where = `${r.hostname ?? r.device_serial}${r.employee ? ` (${r.employee})` : ""}`;
  const what = `${appName(r.application)} «${r.product}»`;
  switch (risk) {
    case "unlicensed":
      return `${what} не активирована на ${where}`;
    case "expired":
      return `Лицензия ${what} истекла ${r.expires_at} на ${where}`;
    case "expiring":
      return `Лицензия ${what} истекает ${r.expires_at?.slice(0, 10)} на ${where}`;
    case "grace":
      return `${what} в льготном периоде (не активирована) на ${where}`;
    case "trial":
      return `${what}: пробная лицензия${r.expires_at ? ` до ${r.expires_at.slice(0, 10)}` : ""} на ${where}`;
    case "key_reuse":
      return seats
        ? `Ключ …${r.partial_key} (${what}) стоит на ${reuseCount} ПК при ${seats} купленных местах (в т.ч. ${where})`
        : `Один ${r.channel ?? ""}-ключ …${r.partial_key} на ${reuseCount} ПК (${what}, в т.ч. ${where})`.replace(
            "Один -ключ",
            "Один ключ",
          );
  }
}

const allRows = (db: DB) => all<LicenseRow>(db, "SELECT * FROM device_license");
const rowKey = (r: LicenseRow) => `${r.device_serial}|${r.application}|${r.product}|${r.partial_key ?? ""}`;

export interface LicenseAlert {
  device_serial: string;
  application: string;
  product: string;
  risk: Risk;
  level: "red" | "yellow";
  text: string;
}

/**
 * Заменить лицензии ПК. Возвращает алерты только по НОВЫМ рискам (которых у этой строки не было до снимка),
 * чтобы ежесуточная сверка не повторяла одно и то же.
 */
export function replaceDeviceLicenses(db: DB, serial: string, list: LicenseIn[]): LicenseAlert[] {
  return tx(db, () => {
    const before = new Map<string, Risk[]>();
    const seats = poolSeats(db);
    for (const [r, risks] of computeRisks(allRows(db), Date.now(), seats)) before.set(rowKey(r), risks);

    db.prepare("DELETE FROM device_license WHERE device_serial = ?").run(serial);
    const ins = db.prepare(
      `INSERT INTO device_license (device_serial, application, product, description, channel, partial_key, status, status_code, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const l of list)
      ins.run(
        serial,
        l.application,
        l.product,
        l.description ?? null,
        l.channel ?? null,
        l.partial_key?.trim() || null,
        l.status,
        l.status_code ?? null,
        l.expires_at ?? null,
      );

    const meta = db
      .prepare(
        "SELECT d.hostname, e.full_name AS employee FROM device d LEFT JOIN employee e ON e.id = d.employee_id WHERE d.serial_number = ?",
      )
      .get(serial) as { hostname: string | null; employee: string | null } | undefined;
    const rows = allRows(db);
    const after = computeRisks(rows, Date.now(), seats);
    const alerts: LicenseAlert[] = [];
    for (const [r, risks] of after) {
      if (r.device_serial !== serial) continue;
      const old = before.get(rowKey(r)) ?? [];
      for (const risk of risks.filter((x) => !old.includes(x))) {
        const reuse =
          risk === "key_reuse"
            ? new Set(
                rows
                  .filter(
                    (x) => x.partial_key === r.partial_key && x.application === r.application && countsForReuse(x),
                  )
                  .map((x) => x.device_serial),
              ).size
            : 0;
        const keySeats = isMsApp(r.application)
          ? undefined
          : seats.get(`${r.application}|${(r.partial_key ?? "").toUpperCase()}`);
        alerts.push({
          device_serial: serial,
          application: r.application,
          product: r.product,
          risk,
          level: RED.has(risk) ? "red" : "yellow",
          text: riskText({ ...r, ...meta }, risk, reuse, keySeats),
        });
      }
    }
    return alerts;
  });
}

/** Список для экрана «Лицензионные ключи»: строки с рисками + сводка. */
export function listLicenseKeys(db: DB, f: { application?: string; risk?: string; device?: string }) {
  const rows = all<LicenseRow & { hostname: string | null; employee: string | null; department: string | null }>(
    db,
    `SELECT l.*, d.hostname, e.full_name AS employee, e.department FROM device_license l
     JOIN device d ON d.serial_number = l.device_serial LEFT JOIN employee e ON e.id = d.employee_id
     ORDER BY l.application, l.product, l.device_serial`,
  );
  const risks = computeRisks(rows, Date.now(), poolSeats(db));
  const items = rows
    .map((r) => {
      const rk = risks.get(r)!;
      return { ...r, risks: rk, severity: severityOf(rk) };
    })
    .filter(
      (r) =>
        (!f.application || r.application === f.application) &&
        (!f.risk || r.risks.includes(f.risk as Risk)) &&
        (!f.device || r.device_serial === f.device),
    )
    .sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const count = (risk: Risk) => new Set(rows.filter((r) => risks.get(r)!.includes(risk)).map((r) => r.id)).size;
  const reusedKeys = new Set(
    rows.filter((r) => risks.get(r)!.includes("key_reuse")).map((r) => `${r.application}|${r.partial_key}`),
  ).size;
  return {
    summary: {
      total: rows.length,
      devices: new Set(rows.map((r) => r.device_serial)).size,
      unlicensed: count("unlicensed"),
      expired: count("expired"),
      expiring: count("expiring"),
      grace: count("grace"),
      trial: count("trial"),
      key_reuse_rows: count("key_reuse"),
      key_reuse_keys: reusedKeys,
      expiring_days: EXPIRING_DAYS,
    },
    items,
  };
}
