/**
 * Отчёты для руководства и выгрузки. Контракт: docs/API.md §20. Тесты: test/reports.test.ts
 *  - agentsWorkbook: все агенты (ПК) в Excel — лист «Агенты» + «Установленное ПО» + «Лицензии ПК»;
 *  - managementData: сводка состояния (одни данные для Excel и PDF);
 *  - managementWorkbook / managementPdf: отчёт для руководства.
 * Закупки, сотрудники, ключи — seed-демо: в отчёте это помечено.
 * Денежных сумм в отчёте нет (как и на дашборде) — только штуки и сроки.
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import type { DB } from "../db.ts";
import { listDevices, type DeviceRow } from "./devices.ts";
import { APP_TITLES, listLicenseKeys } from "./licenses.ts";
import { listPurchases } from "./purchases.ts";
import { complianceReport } from "./report.ts";

// ---------------- общее

const AGENT_LABEL: Record<DeviceRow["agent_status"], string> = {
  online: "В сети",
  offline: "Не в сети",
  lost: "Нет связи > 7 дн.",
  no_agent: "Нет агента",
};
const STATUS_LABEL: Record<string, string> = {
  current: "Актуальное",
  outdated: "Устаревшее",
  forbidden: "Запрещённое",
};
const KIND_LABEL: Record<string, string> = {
  open_source: "Open source",
  freeware: "Freeware",
  shareware: "Shareware",
  trial: "Пробная",
  commercial: "Коммерческая",
};
const RISK_LABEL: Record<string, string> = {
  unlicensed: "не активирована",
  expired: "истекла",
  expiring: "истекает",
  grace: "льготный период",
  trial: "пробная",
  key_reuse: "ключ на нескольких ПК",
};
const LIC_STATUS: Record<string, string> = {
  licensed: "Активирована",
  grace: "Льготный период",
  notification: "Требует активации",
  unlicensed: "Не активирована",
  trial: "Пробная",
  expired: "Истекла",
};
const LIC_APP: Record<string, string> = APP_TITLES;

/** «2026-11-14 08:14:44» (UTC) → Date для Excel/PDF. */
const toDate = (s: string | null | undefined) =>
  s ? new Date(s.includes("T") ? s : `${s.replace(" ", "T")}${s.length > 10 ? "Z" : "T00:00:00Z"}`) : null;
const ruDate = (s: string | null | undefined, time = false) => {
  const d = toDate(s);
  return d
    ? d.toLocaleString("ru-RU", {
        timeZone: "Asia/Yekaterinburg",
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        ...(time ? { hour: "2-digit", minute: "2-digit" } : {}),
      })
    : "—";
};
const daysSince = (s: string | null | undefined) => {
  const d = toDate(s);
  return d ? Math.floor((Date.now() - d.getTime()) / 86_400_000) : null;
};

// ---------------- данные отчёта для руководства

/** Данные отчёта для руководства: сводка, выводы, таблицы (общие для Excel и PDF). */
export function managementData(db: DB) {
  const comp = complianceReport(db);
  const devices = listDevices(db);
  const keys = listLicenseKeys(db, {});
  const purchases = listPurchases(db, {});
  const rows = comp.rows;
  const shortage = rows.filter((r) => r.status === "over").sort((a, b) => b.deficit - a.deficit);
  const forbidden = rows
    .filter((r) => r.status === "forbidden" && r.installed > 0)
    .sort((a, b) => b.installed - a.installed);
  const outdated = rows.filter((r) => r.status === "outdated");
  const idle = rows.filter((r) => r.idle > 0).sort((a, b) => b.idle - a.idle);
  const contracts = purchases
    .filter((p) => p.status === "expiring" || p.status === "expired")
    .sort((a, b) => (a.valid_until ?? "").localeCompare(b.valid_until ?? ""));
  const pcLicenseProblems = keys.items.filter((k) => k.risks.length > 0);
  const lost = devices.filter((d) => d.agent_status === "lost");
  const forbiddenPcs = db
    .prepare(
      `SELECT c.name, d.id, d.hostname, d.serial_number, e.full_name AS employee, e.department FROM installation i
     JOIN software_catalog c ON c.id = i.catalog_id AND c.internal_status = 'forbidden'
     JOIN device d ON d.serial_number = i.device_serial LEFT JOIN employee e ON e.id = d.employee_id
     WHERE i.is_noise = 0 GROUP BY c.id, d.serial_number ORDER BY c.name, d.hostname`,
    )
    .all() as {
    name: string;
    id: number;
    hostname: string | null;
    serial_number: string;
    employee: string | null;
    department: string | null;
  }[];
  const unmatched = db
    .prepare(
      `SELECT MIN(raw_name) AS name, COUNT(DISTINCT device_serial) AS devices FROM installation
     WHERE catalog_id IS NULL AND is_noise = 0 GROUP BY norm_name ORDER BY devices DESC LIMIT 15`,
    )
    .all() as { name: string; devices: number }[];
  const unmatchedTotal = (
    db
      .prepare("SELECT COUNT(DISTINCT norm_name) c FROM installation WHERE catalog_id IS NULL AND is_noise = 0")
      .get() as { c: number }
  ).c;

  return {
    generated_at: new Date().toISOString(),
    kpi: {
      devices: devices.length,
      with_agent: devices.filter((d) => d.agent_status !== "no_agent").length,
      online: devices.filter((d) => d.agent_status === "online").length,
      lost: lost.length,
      products: rows.length,
      shortage_products: shortage.length,
      missing_seats: shortage.reduce((a, r) => a + r.deficit, 0),
      forbidden_products: forbidden.length,
      forbidden_pcs: new Set(forbiddenPcs.map((f) => f.serial_number)).size,
      outdated_products: outdated.length,
      idle_seats: idle.reduce((a, r) => a + r.idle, 0),
      contracts_expiring: contracts.filter((c) => c.status === "expiring").length,
      contracts_expired: contracts.filter((c) => c.status === "expired").length,
      pc_unlicensed: keys.summary.unlicensed,
      pc_expired: keys.summary.expired,
      pc_expiring: keys.summary.expiring,
      key_reuse: keys.summary.key_reuse_keys,
      unmatched_names: unmatchedTotal,
    },
    shortage,
    forbidden,
    forbiddenPcs,
    outdated,
    idle,
    contracts,
    pcLicenseProblems,
    lost,
    unmatched,
  };
}
export type ManagementData = ReturnType<typeof managementData>;

/** Главные выводы одной строкой каждый — в начало отчёта. */
export function highlights(m: ManagementData): string[] {
  const k = m.kpi;
  const out: string[] = [];
  if (k.missing_seats)
    out.push(
      `Не хватает ${k.missing_seats} лицензий по ${k.shortage_products} программам: больше всего — ${m.shortage
        .slice(0, 2)
        .map((r) => `${r.name} (установлено на ${r.installed} ПК, куплено ${r.seats})`)
        .join(", ")}.`,
    );
  if (k.forbidden_pcs)
    out.push(
      `Запрещённое ПО найдено на ${k.forbidden_pcs} ПК (${m.forbidden.map((r) => r.name).join(", ")}) — нужно удалить.`,
    );
  if (k.contracts_expiring || k.contracts_expired)
    out.push(`Договоры: истекает в ближайшие 90 дней — ${k.contracts_expiring}, уже истекли — ${k.contracts_expired}.`);
  if (k.pc_unlicensed || k.pc_expired || k.key_reuse)
    out.push(
      `Лицензии на ПК: не активировано ${k.pc_unlicensed}, истекло ${k.pc_expired}, один ключ на нескольких ПК — ${k.key_reuse}.`,
    );
  if (k.idle_seats)
    out.push(`${k.idle_seats} купленных лицензий не используются — их можно перераспределить вместо новой закупки.`);
  if (k.lost) out.push(`${k.lost} ПК не выходили на связь больше 7 дней — проверить, работает ли агент.`);
  if (!out.length) out.push("Нарушений не найдено: лицензий хватает, запрещённого ПО нет.");
  return out;
}

// ---------------- Excel

interface Col {
  header: string;
  key: string;
  width: number;
  type?: "date" | "datetime" | "int";
}

function sheet(
  wb: ExcelJS.Workbook,
  name: string,
  cols: Col[],
  rows: Record<string, unknown>[],
  opts: { note?: string; highlight?: (r: Record<string, unknown>) => string | null } = {},
) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: opts.note ? 2 : 1 }] });
  if (opts.note) {
    ws.addRow([opts.note]).font = { italic: true, color: { argb: "FF6B7280" } };
    ws.mergeCells(1, 1, 1, cols.length);
  }
  const head = ws.addRow(cols.map((c) => c.header));
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.alignment = { vertical: "middle", wrapText: true };
  head.height = 30;
  head.eachCell((c) => {
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3A5BD9" } };
  });
  cols.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.width;
  });
  for (const r of rows) {
    const row = ws.addRow(
      cols.map((c) => {
        const v = r[c.key];
        if ((c.type === "date" || c.type === "datetime") && typeof v === "string") return toDate(v);
        return v ?? null;
      }),
    );
    cols.forEach((c, i) => {
      if (c.type === "date") row.getCell(i + 1).numFmt = "dd.mm.yyyy";
      if (c.type === "datetime") row.getCell(i + 1).numFmt = "dd.mm.yyyy hh:mm";
    });
    const color = opts.highlight?.(r);
    if (color)
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
      });
  }
  const headRow = opts.note ? 2 : 1;
  if (rows.length)
    ws.autoFilter = { from: { row: headRow, column: 1 }, to: { row: headRow + rows.length, column: cols.length } };
  return ws;
}
const RED = "FFFBE4E2",
  AMBER = "FFFFF4D6",
  GRAY = "FFF1F2F4";

/** Все агенты (ПК): сводка, установленное ПО, лицензии с ПК. */
export async function agentsWorkbook(db: DB): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "EasySAM";
  wb.created = new Date();
  const devices = listDevices(db);
  const keys = listLicenseKeys(db, {});
  const pcIssues = new Map<string, number>();
  for (const k of keys.items)
    if (k.risks.length) pcIssues.set(k.device_serial, (pcIssues.get(k.device_serial) ?? 0) + 1);

  sheet(
    wb,
    "Рабочие места",
    [
      { header: "№", key: "id", width: 6, type: "int" },
      { header: "Имя ПК", key: "hostname", width: 18 },
      { header: "Серийный номер", key: "serial_number", width: 26 },
      { header: "Сотрудник", key: "employee", width: 28 },
      { header: "Отдел", key: "department", width: 22 },
      { header: "ОС", key: "os", width: 22 },
      { header: "Агент", key: "agent", width: 18 },
      { header: "Последний контакт агента", key: "agent_last_seen", width: 18, type: "datetime" },
      { header: "Дней без связи", key: "days", width: 10, type: "int" },
      { header: "Последняя загрузка данных", key: "last_seen", width: 18, type: "datetime" },
      { header: "Программ", key: "software_count", width: 10, type: "int" },
      { header: "Запрещённых", key: "forbidden_count", width: 12, type: "int" },
      { header: "Нераспределённых", key: "unknown_count", width: 12, type: "int" },
      { header: "Проблем с лицензиями ПК", key: "pc_issues", width: 14, type: "int" },
    ],
    devices.map((d) => ({
      ...d,
      agent: AGENT_LABEL[d.agent_status],
      days: d.agent_status === "no_agent" ? null : daysSince(d.agent_last_seen),
      pc_issues: pcIssues.get(d.serial_number) ?? 0,
    })),
    {
      highlight: (r) => (Number(r.forbidden_count) > 0 ? RED : r.agent === AGENT_LABEL.lost ? AMBER : null),
    },
  );

  const software = db
    .prepare(
      `SELECT d.id, d.hostname, d.serial_number, e.full_name AS employee, i.raw_name, i.raw_publisher, i.raw_version, c.name AS catalog_name,
       c.internal_status, c.license_kind, i.last_used FROM installation i JOIN device d ON d.serial_number = i.device_serial
     LEFT JOIN employee e ON e.id = d.employee_id LEFT JOIN software_catalog c ON c.id = i.catalog_id
     WHERE i.is_noise = 0 ORDER BY d.hostname, i.raw_name`,
    )
    .all() as Record<string, unknown>[];
  sheet(
    wb,
    "Установленное ПО",
    [
      { header: "Имя ПК", key: "hostname", width: 16 },
      { header: "Серийный номер", key: "serial_number", width: 24 },
      { header: "Сотрудник", key: "employee", width: 24 },
      { header: "Программа", key: "raw_name", width: 44 },
      { header: "Издатель", key: "raw_publisher", width: 28 },
      { header: "Версия", key: "raw_version", width: 16 },
      { header: "В каталоге", key: "catalog_name", width: 26 },
      { header: "Статус", key: "status", width: 14 },
      { header: "Лицензия", key: "kind", width: 14 },
      { header: "Последний запуск", key: "last_used", width: 16, type: "datetime" },
    ],
    software.map((s) => ({
      ...s,
      status: s.catalog_name ? STATUS_LABEL[s.internal_status as string] : "Нераспределённое",
      kind: KIND_LABEL[s.license_kind as string] ?? null,
    })),
    {
      note: "Без технического шума (драйверы, обновления, компоненты)",
      highlight: (r) => (r.status === "Запрещённое" ? RED : r.status === "Нераспределённое" ? GRAY : null),
    },
  );

  sheet(
    wb,
    "Лицензии ПК",
    [
      { header: "Имя ПК", key: "hostname", width: 16 },
      { header: "Серийный номер", key: "device_serial", width: 24 },
      { header: "Сотрудник", key: "employee", width: 24 },
      { header: "Продукт", key: "app", width: 14 },
      { header: "Редакция", key: "product", width: 34 },
      { header: "Канал", key: "channel", width: 14 },
      { header: "Ключ (5 последних)", key: "partial_key", width: 12 },
      { header: "Статус", key: "st", width: 18 },
      { header: "Действует до", key: "expires_at", width: 14, type: "date" },
      { header: "Риски", key: "risk_text", width: 34 },
    ],
    keys.items.map((k) => ({
      ...k,
      st: LIC_STATUS[k.status] ?? k.status,
      app: LIC_APP[k.application] ?? k.application,
      risk_text: k.risks.map((r) => RISK_LABEL[r] ?? r).join(", ") || null,
    })),
    {
      note: "Ключи — только последние 5 символов (полный ключ с ПК не передаётся)",
      highlight: (r) => (r.severity === "red" ? RED : r.severity === "yellow" ? AMBER : null),
    },
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Отчёт для руководства в Excel: сводка + листы с деталями. */
export async function managementWorkbook(db: DB): Promise<Buffer> {
  const m = managementData(db);
  const k = m.kpi;
  const wb = new ExcelJS.Workbook();
  wb.creator = "EasySAM";
  wb.created = new Date();

  const ws = wb.addWorksheet("Сводка");
  ws.getColumn(1).width = 52;
  ws.getColumn(2).width = 16;
  ws.addRow(["Отчёт о состоянии ПО и лицензий"]).font = { bold: true, size: 16 };
  ws.addRow([`Сформирован ${ruDate(m.generated_at, true)} · SAM`]).font = { color: { argb: "FF6B7280" } };
  ws.addRow([]);
  ws.addRow(["Главное"]).font = { bold: true, size: 12 };
  for (const h of highlights(m)) {
    const r = ws.addRow([`• ${h}`]);
    ws.mergeCells(r.number, 1, r.number, 4);
    r.alignment = { wrapText: true };
    r.height = 32;
  }
  ws.addRow([]);
  ws.addRow(["Показатель", "Значение"]).eachCell((c) => {
    c.font = { bold: true, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF3A5BD9" } };
  });
  const kpis: [string, number, boolean?][] = [
    ["Компьютеров всего", k.devices],
    ["С агентом", k.with_agent],
    ["Агентов в сети сейчас", k.online],
    ["Агентов без связи > 7 дней", k.lost, k.lost > 0],
    ["Позиций в каталоге ПО", k.products],
    ["Программ, где не хватает лицензий", k.shortage_products, k.shortage_products > 0],
    ["Не хватает лицензий, мест", k.missing_seats, k.missing_seats > 0],
    ["Запрещённых программ на ПК", k.forbidden_products, k.forbidden_products > 0],
    ["ПК с запрещённым ПО", k.forbidden_pcs, k.forbidden_pcs > 0],
    ["Программ с устаревшей версией", k.outdated_products],
    ["Купленных, но не используемых лицензий", k.idle_seats],
    ["Договоров истекает за 90 дней", k.contracts_expiring, k.contracts_expiring > 0],
    ["Договоров истекло", k.contracts_expired, k.contracts_expired > 0],
    ["Лицензий ПК не активировано", k.pc_unlicensed, k.pc_unlicensed > 0],
    ["Лицензий ПК истекло", k.pc_expired, k.pc_expired > 0],
    ["Ключей на нескольких ПК", k.key_reuse, k.key_reuse > 0],
    ["Нераспределённых программ (названий)", k.unmatched_names],
  ];
  for (const [label, value, bad] of kpis) {
    const r = ws.addRow([label, value]);
    if (bad) r.getCell(2).font = { bold: true, color: { argb: "FFB5302A" } };
  }
  ws.addRow([]);
  ws.addRow(["Закупки, сотрудники и ключи — демонстрационные данные (в материалах кейса их нет)."]).font = {
    italic: true,
    color: { argb: "FF6B7280" },
  };

  sheet(
    wb,
    "Не хватает лицензий",
    [
      { header: "Программа", key: "name", width: 34 },
      { header: "Тип лицензии", key: "kind", width: 14 },
      { header: "Установлено на ПК", key: "installed", width: 14, type: "int" },
      { header: "Куплено", key: "seats", width: 10, type: "int" },
      { header: "Не хватает", key: "deficit", width: 12, type: "int" },
    ],
    m.shortage.map((r) => ({ ...r, kind: KIND_LABEL[r.license_kind] })),
  );
  sheet(
    wb,
    "Запрещённое ПО",
    [
      { header: "Программа", key: "name", width: 30 },
      { header: "Имя ПК", key: "hostname", width: 16 },
      { header: "Серийный номер", key: "serial_number", width: 24 },
      { header: "Сотрудник", key: "employee", width: 28 },
      { header: "Отдел", key: "department", width: 22 },
    ],
    m.forbiddenPcs,
  );
  sheet(
    wb,
    "Договоры",
    [
      { header: "Программа", key: "catalog_name", width: 30 },
      { header: "Договор", key: "contract", width: 18 },
      { header: "Мест", key: "seats", width: 8, type: "int" },
      { header: "Действует до", key: "valid_until", width: 14, type: "date" },
      { header: "Осталось дней", key: "days_left", width: 12, type: "int" },
      { header: "Статус", key: "st", width: 14 },
    ],
    m.contracts.map((p) => ({ ...p, st: p.status === "expired" ? "Истёк" : "Истекает" })),
    {
      note: "Истекают в ближайшие 90 дней или уже истекли · демо-данные",
      highlight: (r) => (r.st === "Истёк" ? RED : AMBER),
    },
  );
  sheet(
    wb,
    "Простаивают",
    [
      { header: "Программа", key: "name", width: 34 },
      { header: "Куплено", key: "seats", width: 10, type: "int" },
      { header: "Установлено", key: "installed", width: 12, type: "int" },
      { header: "Не используется", key: "idle", width: 16, type: "int" },
    ],
    m.idle,
  );
  sheet(
    wb,
    "Лицензии ПК — проблемы",
    [
      { header: "Имя ПК", key: "hostname", width: 16 },
      { header: "Сотрудник", key: "employee", width: 26 },
      { header: "Продукт", key: "app", width: 14 },
      { header: "Редакция", key: "product", width: 32 },
      { header: "Ключ (5 последних)", key: "partial_key", width: 12 },
      { header: "Проблема", key: "risk_text", width: 34 },
    ],
    m.pcLicenseProblems.map((x) => ({
      ...x,
      app: LIC_APP[x.application] ?? x.application,
      risk_text: x.risks.map((r) => RISK_LABEL[r] ?? r).join(", "),
    })),
  );
  sheet(
    wb,
    "Агенты без связи",
    [
      { header: "Имя ПК", key: "hostname", width: 16 },
      { header: "Серийный номер", key: "serial_number", width: 24 },
      { header: "Сотрудник", key: "employee", width: 26 },
      { header: "Последний контакт", key: "agent_last_seen", width: 18, type: "datetime" },
      { header: "Дней без связи", key: "days", width: 12, type: "int" },
    ],
    m.lost.map((d) => ({ ...d, days: daysSince(d.agent_last_seen) })),
  );
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------- PDF

const FONT = fileURLToPath(new URL("../../assets/fonts/NotoSans-Regular.ttf", import.meta.url));
const FONT_BOLD = fileURLToPath(new URL("../../assets/fonts/NotoSans-Bold.ttf", import.meta.url));
const C = {
  text: "#1f2430",
  muted: "#6b7280",
  line: "#d8dbe0",
  accent: "#3a5bd9",
  red: "#b5302a",
  redBg: "#fbe4e2",
  amber: "#9a6700",
  soft: "#f3f4f6",
};
const MAX_ROWS = 20;

/** Отчёт для руководства в PDF (A4): выводы, показатели, таблицы (по 20 строк; полные списки — в Excel). */
export function managementPdf(db: DB): Promise<Buffer> {
  const m = managementData(db);
  const k = m.kpi;
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 48, bottom: 56, left: 48, right: 48 },
    bufferPages: true,
    info: { Title: "Отчёт о состоянии ПО и лицензий", Author: "EasySAM", CreationDate: new Date() },
  });
  doc.registerFont("r", FONT);
  doc.registerFont("b", FONT_BOLD);
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));
  const W = doc.page.width - 96,
    X = 48;
  const bottom = () => doc.page.height - 56;
  const ensure = (h: number) => {
    if (doc.y + h > bottom()) doc.addPage();
  };

  // шапка
  doc.rect(0, 0, doc.page.width, 92).fill(C.accent);
  doc.fill("#ffffff").font("b").fontSize(20).text("Отчёт о состоянии ПО и лицензий", X, 28, { width: W });
  doc
    .font("r")
    .fontSize(10)
    .fillOpacity(0.85)
    .text(
      `Сформирован ${ruDate(m.generated_at, true)} · ${k.devices} компьютеров · ${k.products} позиций каталога`,
      X,
      58,
      { width: W },
    );
  doc.fillOpacity(1).fill(C.text);
  doc.y = 112;

  // показатели — плитки 4 × 2
  const tiles: [string, string, string?][] = [
    ["Не хватает лицензий", `${k.missing_seats}`, k.missing_seats ? C.red : undefined],
    ["ПК с запрещённым ПО", `${k.forbidden_pcs}`, k.forbidden_pcs ? C.red : undefined],
    ["Договоров истекает (90 дн.)", `${k.contracts_expiring}`, k.contracts_expiring ? C.amber : undefined],
    ["Лицензий ПК не активировано", `${k.pc_unlicensed}`, k.pc_unlicensed ? C.red : undefined],
    ["Агентов в сети", `${k.online} из ${k.with_agent}`],
    ["Без связи > 7 дней", `${k.lost}`, k.lost ? C.amber : undefined],
    ["Лицензий простаивает", `${k.idle_seats}`],
    ["Нераспределённых программ", `${k.unmatched_names}`],
  ];
  const tw = (W - 3 * 10) / 4,
    th = 58;
  const y0 = doc.y; // text() сдвигает курсор — координаты плиток считаем от начала блока
  tiles.forEach(([label, value, color], i) => {
    const x = X + (i % 4) * (tw + 10),
      y = y0 + Math.floor(i / 4) * (th + 10);
    doc.roundedRect(x, y, tw, th, 6).lineWidth(0.8).strokeColor(C.line).stroke();
    doc
      .fill(C.muted)
      .font("r")
      .fontSize(8)
      .text(label, x + 10, y + 8, { width: tw - 20, height: 22, ellipsis: true });
    doc
      .fill(color ?? C.text)
      .font("b")
      .fontSize(17)
      .text(value, x + 10, y + 30, { width: tw - 20, lineBreak: false });
  });
  doc.x = X;
  doc.y = y0 + 2 * th + 10 + 18;
  doc.fill(C.text);

  // главное
  const h2 = (t: string) => {
    ensure(60);
    doc.moveDown(0.3).font("b").fontSize(13).fill(C.text).text(t, X, doc.y, { width: W });
    doc.moveDown(0.3);
  };
  h2("Главное");
  for (const line of highlights(m)) {
    ensure(30);
    const y = doc.y;
    doc.circle(X + 4, y + 6, 2.2).fill(C.accent);
    doc
      .fill(C.text)
      .font("r")
      .fontSize(10)
      .text(line, X + 14, y, { width: W - 14 });
    doc.moveDown(0.35);
  }

  // таблица с переносом строк, повтором шапки на новой странице, подсветкой
  const table = (
    title: string,
    cols: { h: string; w: number; key: string; align?: "left" | "right" }[],
    rows: Record<string, unknown>[],
    opts: { empty?: string; tone?: (r: Record<string, unknown>) => string | null; more?: string } = {},
  ) => {
    ensure(rows.length ? 110 : 60); // заголовок не остаётся внизу страницы без таблицы
    h2(title);
    if (!rows.length) {
      doc
        .font("r")
        .fontSize(10)
        .fill(C.muted)
        .text(opts.empty ?? "Нет", X, doc.y, { width: W });
      doc.fill(C.text);
      doc.moveDown(0.5);
      return;
    }
    const total = cols.reduce((a, c) => a + c.w, 0);
    const ws = cols.map((c) => (c.w / total) * W);
    const head = () => {
      const y = doc.y;
      doc.rect(X, y, W, 20).fill(C.soft);
      let x = X;
      cols.forEach((c, i) => {
        doc
          .fill(C.muted)
          .font("b")
          .fontSize(8)
          .text(c.h, x + 5, y + 6, { width: ws[i] - 10, align: c.align ?? "left", lineBreak: false, ellipsis: true });
        x += ws[i];
      });
      doc.y = y + 20;
    };
    head();
    for (const r of rows.slice(0, MAX_ROWS)) {
      doc.font("r").fontSize(9);
      const cells = cols.map((c) => String(r[c.key] ?? "—"));
      const h = Math.max(...cells.map((t, i) => doc.heightOfString(t, { width: ws[i] - 10 }))) + 10;
      if (doc.y + h > bottom()) {
        doc.addPage();
        head();
      }
      const y = doc.y;
      const tone = opts.tone?.(r);
      if (tone) doc.rect(X, y, W, h).fill(tone);
      let x = X;
      cells.forEach((t, i) => {
        doc
          .fill(C.text)
          .font("r")
          .fontSize(9)
          .text(t, x + 5, y + 5, { width: ws[i] - 10, align: cols[i].align ?? "left" });
        x += ws[i];
      });
      doc
        .moveTo(X, y + h)
        .lineTo(X + W, y + h)
        .lineWidth(0.5)
        .strokeColor(C.line)
        .stroke();
      doc.y = y + h;
    }
    if (rows.length > MAX_ROWS)
      doc
        .moveDown(0.3)
        .font("r")
        .fontSize(9)
        .fill(C.muted)
        .text(
          `…и ещё ${rows.length - MAX_ROWS} — полный список в Excel-отчёте${opts.more ? `, лист «${opts.more}»` : ""}.`,
          X,
          doc.y,
          { width: W },
        );
    doc.fill(C.text).moveDown(0.8);
  };

  table(
    "Не хватает лицензий",
    [
      { h: "Программа", w: 4, key: "name" },
      { h: "Установлено на ПК", w: 2, key: "installed", align: "right" },
      { h: "Куплено", w: 1.4, key: "seats", align: "right" },
      { h: "Не хватает", w: 1.6, key: "deficit", align: "right" },
    ],
    m.shortage,
    { empty: "Лицензий хватает на все установки.", more: "Не хватает лицензий" },
  );
  table(
    "Запрещённое ПО на компьютерах",
    [
      { h: "Программа", w: 3, key: "name" },
      { h: "Имя ПК", w: 2, key: "hostname" },
      { h: "Сотрудник", w: 3, key: "employee" },
      { h: "Отдел", w: 2.4, key: "department" },
    ],
    m.forbiddenPcs,
    { empty: "Запрещённого ПО на компьютерах нет.", tone: () => C.redBg, more: "Запрещённое ПО" },
  );
  table(
    "Договоры: истекают в 90 дней и истёкшие (демо-данные)",
    [
      { h: "Программа", w: 3, key: "catalog_name" },
      { h: "Договор", w: 2, key: "contract" },
      { h: "Мест", w: 1, key: "seats", align: "right" },
      { h: "Действует до", w: 1.8, key: "until" },
      { h: "Статус", w: 1.6, key: "st" },
    ],
    m.contracts.map((p) => ({
      ...p,
      until: ruDate(p.valid_until),
      st: p.status === "expired" ? "истёк" : `через ${p.days_left} дн.`,
    })),
    { empty: "Ближайших окончаний договоров нет.", more: "Договоры" },
  );
  table(
    "Лицензии на компьютерах: проблемы",
    [
      { h: "Имя ПК", w: 1.8, key: "hostname" },
      { h: "Продукт", w: 3.2, key: "prod" },
      { h: "Ключ", w: 1.2, key: "partial_key" },
      { h: "Проблема", w: 3.4, key: "risk_text" },
    ],
    m.pcLicenseProblems.map((x) => ({
      ...x,
      prod: x.product.startsWith(LIC_APP[x.application] ?? "\u0000")
        ? x.product
        : `${LIC_APP[x.application] ?? x.application}: ${x.product}`,
      partial_key: x.partial_key ? `…${x.partial_key}` : "—",
      risk_text: x.risks.map((r) => RISK_LABEL[r] ?? r).join(", "),
    })),
    { empty: "Проблем с лицензиями на компьютерах нет.", more: "Лицензии ПК — проблемы" },
  );
  table(
    "Купленные, но не используемые лицензии",
    [
      { h: "Программа", w: 4, key: "name" },
      { h: "Куплено", w: 1.5, key: "seats", align: "right" },
      { h: "Установлено", w: 1.5, key: "installed", align: "right" },
      { h: "Свободно", w: 1.5, key: "idle", align: "right" },
    ],
    m.idle,
    { empty: "Все купленные лицензии используются.", more: "Простаивают" },
  );
  table(
    "Агенты без связи больше 7 дней",
    [
      { h: "Имя ПК", w: 2, key: "hostname" },
      { h: "Сотрудник", w: 3, key: "employee" },
      { h: "Последний контакт", w: 2.4, key: "seen" },
      { h: "Дней", w: 1, key: "days", align: "right" },
    ],
    m.lost.map((d) => ({ ...d, seen: ruDate(d.agent_last_seen, true), days: daysSince(d.agent_last_seen) })),
    { empty: "Все агенты выходили на связь за последнюю неделю.", more: "Агенты без связи" },
  );
  table(
    "Самые частые нераспределённые программы",
    [
      { h: "Название", w: 6, key: "name" },
      { h: "ПК", w: 1, key: "devices", align: "right" },
    ],
    m.unmatched,
    { empty: "Нераспределённых программ нет." },
  );

  // подвал на всех страницах
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // иначе текст ниже поля pdfkit сочтёт переполнением и добавит пустую страницу
    doc.font("r").fontSize(8).fill(C.muted);
    const y = doc.page.height - 36;
    doc.text("EasySAM — учёт ПО и лицензий · закупки, сотрудники и ключи в демо-базе — демонстрационные данные", X, y, {
      width: W - 80,
      lineBreak: false,
    });
    doc.text(`стр. ${i - range.start + 1} из ${range.count}`, X + W - 80, y, {
      width: 80,
      align: "right",
      lineBreak: false,
    });
  }
  doc.end();
  return done;
}

/** Имя файла с датой: easysam-report-2026-11-14.pdf */
export const reportFileName = (base: string, ext: string) => `${base}-${new Date().toISOString().slice(0, 10)}.${ext}`;
