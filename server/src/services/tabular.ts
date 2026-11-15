/**
 * Разбор загруженной таблицы установок: CSV (; , или TAB, UTF-8/BOM, кавычки) и XLSX → строки по устройствам.
 * Колонки ищутся по имени шапки без учёта регистра и префиксов: SERIAL_NUMBER | COMPUTERS.SERIAL_NUMBER,
 * DISPLAYNAME | NAME, PUBLISHER, VERSION; необязательно HOSTNAME, OS. '<Null>' и пусто = нет значения.
 * Тесты: test/csv.test.ts
 */
import ExcelJS from "exceljs";
import type { RawItem } from "./ingest.ts";

export class UploadError extends Error {}

const NULLS = new Set(["", "<null>", "null"]);
const MAX_ROWS = 500_000;

/** Минимальный RFC-4180 парсер: кавычки, «""», переводы строк внутри кавычек. */
export function parseDelimited(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const count = (c: string) => first.split(c).length - 1;
  const delim = [";", "\t", ","].sort((a, b) => count(b) - count(a))[0];
  const rows: string[][] = [];
  let row: string[] = [],
    cur = "",
    quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"' && cur === "") quoted = true;
    else if (ch === delim) {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cur);
      cur = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) throw new UploadError(`слишком много строк (>${MAX_ROWS})`);
    } else cur += ch;
  }
  row.push(cur);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

/** Значение ячейки Excel как текст (формулы — результатом, даты — YYYY-MM-DD). */
export const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10); // дата Excel → YYYY-MM-DD (иначе «Wed Dec 31 2027 …»)
  if (typeof v === "object" && "richText" in v) return v.richText.map((t) => t.text).join("");
  if (typeof v === "object" && "result" in v)
    return v.result instanceof Date ? v.result.toISOString().slice(0, 10) : String(v.result ?? "");
  if (typeof v === "object" && "text" in v) return String((v as { text: unknown }).text ?? ""); // гиперссылка
  return String(v);
};

/** Первый лист .xlsx как строки таблицы. */
export async function parseXlsx(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new UploadError("в файле нет листов");
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const cells: string[] = [];
    for (let c = 1; c <= 12; c++) cells.push(cellText(r.getCell(c).value)); // читаем только первые колонки (в листах бывают 16 тыс. пустых)
    rows.push(cells);
  });
  return rows;
}

/** Файл .csv или .xlsx как строки таблицы; UploadError — формат не поддерживается. */
export async function parseUpload(filename: string, buf: Buffer): Promise<string[][]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".xlsx")) return parseXlsx(buf);
  if (lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".tsv"))
    return parseDelimited(buf.toString("utf8"));
  throw new UploadError("поддерживаются файлы .csv и .xlsx");
}

const key = (h: string) =>
  h
    .trim()
    .toLowerCase()
    .replace(/^.*\./, "")
    .replace(/[\s_-]/g, "");
const ALIASES: Record<string, string[]> = {
  serial: ["serialnumber", "serial", "sn", "deviceid"],
  name: ["displayname", "name", "software", "softwarename", "application"],
  publisher: ["publisher", "vendor"],
  version: ["version", "displayversion"],
  hostname: ["hostname", "computername", "computer"],
  os: ["os", "osname"],
};

export interface DeviceRows {
  serial_number: string;
  hostname: string | null;
  os: string | null;
  items: RawItem[];
}
export interface ParsedTable {
  devices: DeviceRows[];
  rowsInFile: number;
}

/**
 * Строки выгрузки → ПК со списком ПО; UploadError — файл пустой, нет обязательных колонок или ни одной полной
 * строки.
 */
export function toDevices(rows: string[][]): ParsedTable {
  if (rows.length < 2) throw new UploadError("файл пустой или без строк данных");
  const head = rows[0].map(key);
  const col: Record<string, number> = {};
  for (const [field, names] of Object.entries(ALIASES)) col[field] = head.findIndex((h) => names.includes(h));
  const missing = ["serial", "name"].filter((f) => col[f] < 0);
  if (missing.length)
    throw new UploadError(
      `не найдены колонки: ${missing.map((m) => (m === "serial" ? "SERIAL_NUMBER" : "DISPLAYNAME")).join(", ")} (шапка: ${rows[0].join(" | ").slice(0, 120)})`,
    );

  const val = (r: string[], f: string): string | null => {
    const i = col[f];
    const v = i >= 0 ? (r[i] ?? "").trim() : "";
    return NULLS.has(v.toLowerCase()) ? null : v;
  };
  const by = new Map<string, DeviceRows>();
  let n = 0;
  for (const r of rows.slice(1)) {
    const serial = val(r, "serial"),
      name = val(r, "name");
    if (!serial || !name) continue;
    n++;
    let d = by.get(serial);
    if (!d) by.set(serial, (d = { serial_number: serial, hostname: val(r, "hostname"), os: val(r, "os"), items: [] }));
    d.items.push({ name, publisher: val(r, "publisher"), version: val(r, "version") });
  }
  if (!by.size) throw new UploadError("не нашёл ни одной строки с серийным номером и названием ПО");
  return { devices: [...by.values()], rowsInFile: n };
}
