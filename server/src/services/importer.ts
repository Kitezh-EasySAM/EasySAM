/**
 * Импорт из Excel/CSV: сотрудники, каталог ПО, закупки лицензий. Колонки — по заголовкам (рус/англ), строка шапки
 * ищется в первых 6 строках (формат организаторов «Пример перечня софта»: шапка во 2-й строке, «Наименование БПО»).
 * Обновление без дублей: сотрудник — по ФИО, ПО — по названию, закупка — по (ПО, договор).
 * dryRun — всё то же самое в транзакции с откатом: «предпросмотр» без записи.
 * Тесты: test/importer.test.ts
 */
import type { DB } from "../db.ts";
import { trimEndChars } from "./text.ts";
export { template } from "./importTemplate.ts";

export type ImportKind = "employees" | "catalog" | "purchases";
export interface ImportResult {
  kind: ImportKind;
  rows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: { row: number; error: string }[];
  dry_run: boolean;
}

const key = (h: string) =>
  h
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]/g, "");

/** Поле → варианты заголовка (после key()). */
const COLUMNS: Record<ImportKind, Record<string, string[]>> = {
  employees: {
    full_name: ["фио", "сотрудник", "фамилияимяотчество", "имя", "fullname", "name", "employee"],
    department: ["отдел", "подразделение", "department", "dept"],
    active: ["активен", "работает", "статус", "active", "status"],
    device_serial: ["пк", "серийныйномер", "серийныйномерпк", "sn", "serial", "serialnumber", "компьютер"],
  },
  catalog: {
    name: ["наименование", "название", "наименованиебпо", "по", "программа", "name", "software", "product"],
    vendor: ["вендор", "производитель", "издатель", "разработчик", "vendor", "publisher"],
    version: ["версия", "версиябпо", "version"],
    purpose: ["назначение", "краткоеназначениебпо", "описание", "purpose", "description"],
    registry_section: ["раздел", "разделреестра", "классификациябпо", "section"],
    registry_class: ["класс", "классреестра", "class"],
    license_kind: ["типлицензии", "тип", "licensekind", "kind"],
    license: ["лицензионноесоглашение", "соглашение", "лицензия", "license", "eula"],
    internal_status: ["статус", "статусвкомпании", "status"],
    min_version: ["минверсия", "минимальнаяверсия", "minversion"],
    in_ru_registry: ["реестррф", "реестррусскогопо", "вреестре", "ruregistry"],
    list_price: ["цена", "ценаместа", "стоимость", "price"],
  },
  purchases: {
    catalog_name: ["по", "программа", "продукт", "наименование", "название", "software", "product", "name"],
    seats: ["мест", "количество", "колво", "лицензий", "seats", "qty", "quantity"],
    unit_price: ["цена", "ценаместа", "ценазаединицу", "стоимостьместа", "price", "unitprice"],
    valid_until: ["действуетдо", "срок", "сроклицензии", "окончание", "validuntil", "expires"],
    contract: ["договор", "номердоговора", "contract"],
  },
};
const REQUIRED: Record<ImportKind, string[]> = {
  employees: ["full_name"],
  catalog: ["name"],
  purchases: ["catalog_name", "seats"],
};
const LABEL: Record<string, string> = { full_name: "ФИО", name: "Наименование", catalog_name: "ПО", seats: "Мест" };

const KIND: [RegExp, string][] = [
  [/коммерч|платн|commercial|paid/, "commercial"],
  [/условно|shareware/, "shareware"],
  [/проб|trial|demo|демо/, "trial"],
  [/open ?source|gnu|gpl|mit|bsd|apache|открыт|свобод/, "open_source"],
  [/бесплат|freeware|free/, "freeware"],
];
const STATUS: [RegExp, string][] = [
  [/запрещ|forbidden|ban/, "forbidden"],
  [/устар|outdated|obsolete/, "outdated"],
  [/актуал|разреш|current|ok/, "current"],
];
const pick = (v: string, map: [RegExp, string][]) => map.find(([re]) => re.test(v.toLowerCase()))?.[1] ?? null;
const yes = (v: string) =>
  /^(да|yes|true|1|\+|в реестре|есть)/i.test(v.trim()) ? 1 : /^(нет|no|false|0|-|не)/i.test(v.trim()) ? 0 : null;

/** «31.12.2027», «2027-12-31», серийное число Excel → YYYY-MM-DD; пусто/«бессрочно» → null. */
export function parseDate(v: string): string | null | "bad" {
  const s = v.trim();
  if (!s || /бессроч|perpetual|∞|^-$/i.test(s)) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  if (/^\d{5}$/.test(s)) return new Date(Date.UTC(1899, 11, 30) + Number(s) * 86_400_000).toISOString().slice(0, 10);
  return "bad";
}
const num = (v: string) => {
  const n = Number(trimEndChars(v.replace(/\s/g, "").replace(",", "."), "₽.рубРУБ"));
  return Number.isFinite(n) ? n : Number.NaN;
};

/** Найти строку шапки и сопоставить колонки. */
export function mapColumns(rows: string[][], kind: ImportKind): { header: number; col: Record<string, number> } {
  for (let h = 0; h < Math.min(6, rows.length); h++) {
    const keys = rows[h].map(key);
    const col: Record<string, number> = {};
    for (const [field, names] of Object.entries(COLUMNS[kind])) {
      const i = keys.findIndex((k) => names.includes(k));
      if (i >= 0 && !Object.values(col).includes(i)) col[field] = i;
    }
    if (REQUIRED[kind].every((f) => f in col)) return { header: h, col };
  }
  throw new Error(
    `не найдены колонки: ${REQUIRED[kind].map((f) => LABEL[f] ?? f).join(", ")} (проверьте заголовки в первых строках)`,
  );
}

class Rollback extends Error {}

/**
 * Импорт строк таблицы в транзакции; dryRun — то же с откатом (предпросмотр). Ошибки строк — в errors, не
 * исключением.
 */
export function importRows(db: DB, kind: ImportKind, rows: string[][], dryRun = false): ImportResult {
  const { header, col } = mapColumns(rows, kind);
  const res: ImportResult = { kind, rows: 0, created: 0, updated: 0, skipped: 0, errors: [], dry_run: dryRun };
  const get = (r: string[], f: string) => (f in col ? (r[col[f]] ?? "").trim() : "");
  db.exec("BEGIN");
  try {
    rows.slice(header + 1).forEach((r, i) => {
      const line = header + i + 2; // номер строки в файле (с 1)
      if (r.every((c) => !c?.trim())) return;
      res.rows++;
      try {
        const changed =
          kind === "employees"
            ? importEmployee(db, (f) => get(r, f))
            : kind === "catalog"
              ? importCatalog(db, (f) => get(r, f))
              : importPurchase(db, (f) => get(r, f));
        res[changed]++;
      } catch (e) {
        res.errors.push({ row: line, error: (e as Error).message });
      }
    });
    if (dryRun) throw new Rollback();
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    if (!(e instanceof Rollback)) throw e;
  }
  return res;
}

type Get = (field: string) => string;

function importEmployee(db: DB, g: Get): "created" | "updated" | "skipped" {
  const name = g("full_name");
  if (!name) return "skipped";
  const active = g("active") ? (/уволен|неактив|нет|no|false|0/i.test(g("active")) ? 0 : 1) : null;
  const ex = db.prepare("SELECT id FROM employee WHERE ulower(full_name) = ?").get(name.toLowerCase()) as
    { id: number } | undefined;
  let id: number, out: "created" | "updated";
  if (ex) {
    db.prepare(
      "UPDATE employee SET department = COALESCE(?, department), active = COALESCE(?, active) WHERE id = ?",
    ).run(g("department") || null, active, ex.id);
    id = ex.id;
    out = "updated";
  } else {
    id = Number(
      db
        .prepare("INSERT INTO employee (full_name, department, active) VALUES (?, ?, ?)")
        .run(name, g("department") || null, active ?? 1).lastInsertRowid,
    );
    out = "created";
  }
  const sn = g("device_serial");
  if (sn) {
    if (!db.prepare("SELECT 1 FROM device WHERE serial_number = ?").get(sn))
      throw new Error(`ПК «${sn}» не найден — сотрудник сохранён без привязки`);
    db.prepare("UPDATE device SET employee_id = ? WHERE serial_number = ?").run(id, sn);
  }
  return out;
}

function importCatalog(db: DB, g: Get): "created" | "updated" | "skipped" {
  const name = g("name").split(",")[0].replace(/\s+/g, " ").trim();
  if (!name) return "skipped";
  const licText = g("license");
  const kind = pick(g("license_kind") || licText, KIND);
  const status = g("internal_status") ? pick(g("internal_status"), STATUS) : null;
  if (g("internal_status") && !status)
    throw new Error(`статус «${g("internal_status")}»: ожидается актуальный / устаревший / запрещён`);
  const price = g("list_price") ? num(g("list_price")) : null;
  if (price !== null && Number.isNaN(price)) throw new Error(`цена «${g("list_price")}» — не число`);
  let ltId: number | null = null;
  if (licText) {
    const first = licText.split(/[;\n]/)[0].trim().slice(0, 200);
    const lt = db.prepare("SELECT id FROM license_type WHERE ulower(name) = ?").get(first.toLowerCase()) as
      { id: number } | undefined;
    ltId =
      lt?.id ??
      Number(
        db.prepare("INSERT INTO license_type (name, kind) VALUES (?, ?)").run(first, kind ?? "freeware")
          .lastInsertRowid,
      );
  }
  const vals = {
    vendor: g("vendor") || null,
    purpose: g("purpose") || null,
    registry_section: g("registry_section") || null,
    registry_class: g("registry_class") || null,
    license_kind: kind,
    internal_status: status,
    min_version: g("min_version") || null,
    in_ru_registry: g("in_ru_registry") ? yes(g("in_ru_registry")) : null,
    list_price: price,
    license_type_id: ltId,
  };
  const ex = db.prepare("SELECT id FROM software_catalog WHERE ulower(name) = ?").get(name.toLowerCase()) as
    { id: number } | undefined;
  if (ex) {
    // обновляем только то, что есть в файле
    const set = Object.entries(vals).filter(([, v]) => v !== null && v !== undefined);
    if (set.length)
      db.prepare(`UPDATE software_catalog SET ${set.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
        ...set.map(([, v]) => v as string | number),
        ex.id,
      );
    return "updated";
  }
  db.prepare(
    `INSERT INTO software_catalog (name, vendor, purpose, registry_section, registry_class, license_kind,
       internal_status, min_version, in_ru_registry, list_price, license_type_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    name,
    vals.vendor,
    vals.purpose,
    vals.registry_section,
    vals.registry_class,
    vals.license_kind ?? "freeware",
    vals.internal_status ?? "current",
    vals.min_version,
    vals.in_ru_registry,
    vals.list_price,
    vals.license_type_id,
  );
  return "created";
}

function importPurchase(db: DB, g: Get): "created" | "updated" | "skipped" {
  const name = g("catalog_name");
  if (!name) return "skipped";
  const cat = db.prepare("SELECT id FROM software_catalog WHERE ulower(name) = ?").get(name.toLowerCase()) as
    { id: number } | undefined;
  if (!cat) throw new Error(`ПО «${name}» нет в каталоге — сначала добавьте его (вкладка «ПО» или импорт каталога)`);
  const seats = num(g("seats"));
  if (!Number.isInteger(seats) || seats < 0) throw new Error(`«Мест» = «${g("seats")}» — нужно целое число`);
  const price = g("unit_price") ? num(g("unit_price")) : 0;
  if (Number.isNaN(price)) throw new Error(`цена «${g("unit_price")}» — не число`);
  const until = parseDate(g("valid_until"));
  if (until === "bad") throw new Error(`дата «${g("valid_until")}» не распознана (нужно 31.12.2027 или 2027-12-31)`);
  const contract = g("contract") || null;
  const ex = contract
    ? (db.prepare("SELECT id FROM license_purchase WHERE catalog_id = ? AND contract = ?").get(cat.id, contract) as
        { id: number } | undefined)
    : undefined;
  if (ex) {
    db.prepare("UPDATE license_purchase SET seats = ?, unit_price = ?, valid_until = ? WHERE id = ?").run(
      seats,
      price,
      until,
      ex.id,
    );
    return "updated";
  }
  db.prepare(
    "INSERT INTO license_purchase (catalog_id, seats, unit_price, valid_until, contract) VALUES (?, ?, ?, ?, ?)",
  ).run(cat.id, seats, price, until, contract);
  return "created";
}
