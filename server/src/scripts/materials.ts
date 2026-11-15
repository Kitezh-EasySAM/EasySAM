/** Чтение xlsx из материалы/. Имена файлов на диске «битые», поэтому тип определяем по шапке. */
import ExcelJS from "exceljs";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MATERIALS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../материалы");
/** Есть ли файлы организаторов (в открытом репозитории их нет — тесты на реальных данных пропускаются). */
export const hasMaterials = (): boolean =>
  existsSync(MATERIALS) && readdirSync(MATERIALS).some((n) => n.endsWith(".xlsx") && !n.startsWith(".~"));

const MARKERS = {
  hosts: "SERIAL_NUMBER",
  licenses: "Наименование лицензионного соглашения",
  catalog: "Наименование БПО",
} as const;

export const cell = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (typeof v === "object" && "richText" in v) return v.richText.map((t) => t.text).join("");
  if (typeof v === "object" && "result" in v) return String(v.result ?? "");
  return String(v);
};

export async function findWorkbook(kind: keyof typeof MARKERS): Promise<ExcelJS.Worksheet> {
  for (const f of readdirSync(MATERIALS).filter((n) => n.endsWith(".xlsx") && !n.startsWith(".~"))) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(MATERIALS, f));
    const ws = wb.worksheets[0];
    const head = [1, 2, 3, 4]
      .map((r) => ws.getRow(r).values as ExcelJS.CellValue[])
      .flat()
      .map(cell)
      .join(" ");
    if (head.includes(MARKERS[kind])) return ws;
  }
  throw new Error(`не нашёл xlsx типа «${kind}» в ${MATERIALS}`);
}

export interface HostRow {
  serial: string;
  name: string;
  publisher: string | null;
  version: string | null;
}

/** Выгрузка агентов: SERIAL_NUMBER, DISPLAYNAME, PUBLISHER, VERSION; '<Null>' -> null */
export async function readHostRows(): Promise<HostRow[]> {
  const ws = await findWorkbook("hosts");
  const clean = (v: ExcelJS.CellValue) => {
    const s = cell(v).trim();
    return s === "" || s === "<Null>" ? null : s;
  };
  const out: HostRow[] = [];
  ws.eachRow((row, i) => {
    if (i === 1) return;
    const serial = clean(row.getCell(1).value),
      name = clean(row.getCell(2).value);
    if (serial && name)
      out.push({ serial, name, publisher: clean(row.getCell(3).value), version: clean(row.getCell(4).value) });
  });
  return out;
}

const t = (ws: ExcelJS.Worksheet, r: number, c: number) =>
  cell(ws.getRow(r).getCell(c).value).replace(/\s+/g, " ").trim();

export interface CatalogRow {
  name: string;
  version: string;
  purpose: string;
  section: string;
  klass: string;
  license: string;
}

/**
 * Перечень разрешённого ПО: БПО | версия | назначение | раздел | класс | лицензия. Читаем только 6 колонок (в листе
 * 16 тыс. пустых).
 */
export async function readCatalogRows(): Promise<CatalogRow[]> {
  const ws = await findWorkbook("catalog");
  const out: CatalogRow[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    if (!/^\d{2} - /.test(t(ws, r, 4))) continue; // строки данных: в 4-й колонке «04 - Средства…»
    out.push({
      name: t(ws, r, 1),
      version: t(ws, r, 2),
      purpose: t(ws, r, 3),
      section: t(ws, r, 4),
      klass: t(ws, r, 5),
      license: cell(ws.getRow(r).getCell(6).value)
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .join("; "),
    });
  }
  return out;
}

/** Справочник лицензионных соглашений: имена из 1-й колонки. */
export async function readLicenseNames(): Promise<string[]> {
  const ws = await findWorkbook("licenses");
  const out: string[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const n = t(ws, r, 1);
    if (n && !n.startsWith("Наименование лицензионного")) out.push(n);
  }
  return out;
}
