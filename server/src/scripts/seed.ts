/**
 * Наполнение БД в два шага (тесты: test/seed.test.ts):
 *  seedBase — РЕАЛЬНОЕ из материалов: справочник лицензий (33), перечень ПО (49 → уникальные), установки (24 589
 *   строк, 187 хостов),
 *             распознавание корпоративных продуктов (названия и вендоры из seed-data.ts, без цен и статусов).
 *             Имена ПК «WS-001…» — подписи (в выгрузке имён нет), ОС не задана (в выгрузке её нет).
 *  seedDemo — ДЕМО (в материалах нет!): ОС ПК, закупки и цены, сотрудники и привязка ПК к людям, «последний запуск»,
 *             статусы «запрещено/устарело» и нужные версии, лицензии Windows/Office с ПК, КриптоПро (ключи в
 *   хранилище, 87 ПК).
 *             Сценарии: Office установлен больше купленного (red/over), Photoshop CS4 без лицензии, WinRAR запрещён
 *   (red/forbidden),
 *             Visio куплен с запасом (yellow/idle), Java 6/7 устарела, Oracle Java превышение.
 * Детерминированно (PRNG с фиксированным зерном): seedBase + seedDemo дают ровно те же данные, что прежний общий seed.
 * `make fresh` — чистая БД с реальными данными; `make demo` — добавить демо; `make fresh-demo` — оба шага.
 */
import type { DB } from "../db.ts";
import { tx } from "../db.ts";
import type { InternalStatus, LicenseKind } from "../services/compliance.ts";
import { applySnapshot } from "../services/ingest.ts";
import { isNoise, normalizeName } from "../services/normalize.ts";
import { DEPARTMENTS, CORPORATE, FEMALE, FIRST, LAST } from "./seed-data.ts";
import { readCatalogRows, readHostRows, readLicenseNames } from "./materials.ts";
import { byCodeUnit } from "../services/text.ts";

function rng(seed: number) {
  // mulberry32
  const state = Int32Array.of(seed); // запись в Int32Array сама обрезает до 32 бит
  return () => {
    state[0] += 0x6d2b79f5;
    const s = state[0];
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FREE_RE = /freeware|eula|условия предоставления|лицензионное соглашение|hyperionics|devart|cadel|microsoft для/i;
const COPYLEFT_RE = /gnu|gpl|affero|mozilla|eclipse|cddl|common public/i;

export function inferKind(license: string): LicenseKind {
  return FREE_RE.test(license) && !/gnu|apache|mit\b/i.test(license) ? "freeware" : "open_source";
}

function upsertLicenseType(db: DB, name: string, kind: LicenseKind): number {
  const row = db.prepare("SELECT id FROM license_type WHERE name = ?").get(name) as { id: number } | undefined;
  if (row) return row.id;
  const commercialUse = kind === "open_source" ? 1 : null; // EULA: надо читать (разбор ИИ)
  const copyleft = kind === "open_source" ? (COPYLEFT_RE.test(name) ? 1 : 0) : null;
  return Number(
    db
      .prepare("INSERT INTO license_type (name, kind, commercial_use, copyleft) VALUES (?, ?, ?, ?)")
      .run(name, kind, commercialUse, copyleft).lastInsertRowid,
  );
}

/** Подбор типа лицензии для строки каталога по тексту «GNU GPL v.2», «MIT License»… */
function findLicenseId(db: DB, text: string, kind: LicenseKind): number | null {
  if (!text) return null;
  const first = text.split(";")[0].trim();
  const rules: [RegExp, RegExp][] = [
    [/gpl (v\.?\s?)?2|gpl 2/i, /GPL v\.2/i],
    [/gpl (v\.?\s?)?3/i, /GPL v\.3/i],
    [/affero/i, /Affero/i],
    [/lgpl/i, /LGPL/i],
    [/^mit/i, /^MIT/i],
    [/bsd 3/i, /BSD 3/i],
    [/bsd 2/i, /BSD 2/i],
    [/apache/i, /^Apache/i],
    [/postgresql/i, /^PostgreSQL$|под лицензией postgresql/i],
    [/eclipse/i, /Eclipse/i],
    [/freeware/i, /PDFCreator Freeware|pdfforge/i],
    [/nvidia/i, /Nvidia/i],
  ];
  const all = db.prepare("SELECT id, name FROM license_type").all() as { id: number; name: string }[];
  for (const [src, dst] of rules)
    if (src.test(first)) {
      const t = all.find((x) => dst.test(x.name));
      if (t) return t.id;
    }
  return upsertLicenseType(db, first.slice(0, 200), kind);
}

export interface BaseStats {
  licenseTypes: number;
  catalog: number;
  aliases: number;
  devices: number;
  rows: number;
}
export interface DemoStats {
  deviceLicenses: number;
  employees: number;
  purchases: number;
  devices: number;
}
export type SeedStats = BaseStats & DemoStats;

const count = (db: DB, sql: string) => (db.prepare(sql).get() as { c: number }).c;

/** Реальные данные из материалов на пустую БД. */
export async function seedBase(db: DB): Promise<BaseStats> {
  if (count(db, "SELECT COUNT(*) c FROM software_catalog") > 0)
    throw new Error("БД не пустая: сначала `make reset-db` (или `make fresh`)");
  // файлов организаторов может не быть (в открытом репозитории их нет) — тогда только корпоративный каталог
  const optional = <T>(read: () => Promise<T[]>, what: string): Promise<T[]> =>
    read().catch((e: unknown) => {
      console.warn(`[seed] ${what}: ${e instanceof Error ? e.message : String(e)} — пропускаю`);
      return [];
    });
  const hosts = await optional(readHostRows, "выгрузка с ПК");
  const serials = [...new Set(hosts.map((h) => h.serial))].sort(byCodeUnit);
  const names = [...new Set(hosts.filter((h) => !isNoise(h.name)).map((h) => h.name))];

  let aliases = 0;
  const corpIds = new Map<string, number>();
  const xlsxCatalog = new Map<string, number>(); // нормализованное имя → id

  // 1) справочник лицензий + каталог из файлов организаторов + корпоративные продукты + алиасы + закупки (одна
  // транзакция)
  const licNames = await optional(readLicenseNames, "перечень лицензий");
  const catRows = await optional(readCatalogRows, "перечень ПО");
  tx(db, () => {
    for (const n of licNames) upsertLicenseType(db, n, inferKind(n));

    for (const r of catRows) {
      const name = (r.name.split(",")[0] ?? "").replace(/\s+/g, " ").trim();
      if (!name) continue;
      const kind = inferKind(r.license);
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO software_catalog (name, purpose, registry_section, registry_class, license_type_id, license_kind, internal_status)
         VALUES (?, ?, ?, ?, ?, ?, 'current')`,
        )
        .run(name, r.purpose, r.section, r.klass, findLicenseId(db, r.license, kind), kind);
      if (res.changes) xlsxCatalog.set(normalizeName(name), Number(res.lastInsertRowid));
    }
    // корпоративные продукты (их нет в перечне организаторов, но они стоят на хостах); статусы, версии и цены — в
    // seedDemo
    for (const c of CORPORATE) {
      const licId = upsertLicenseType(db, c.license, c.kind);
      const res = db
        .prepare(
          `INSERT OR IGNORE INTO software_catalog (name, vendor, registry_section, registry_class, license_type_id, license_kind, internal_status, in_ru_registry)
         VALUES (?, ?, ?, ?, ?, ?, 'current', ?)`,
        )
        .run(c.name, c.vendor, c.section, c.klass, licId, c.kind, c.inRuRegistry ? 1 : null);
      corpIds.set(
        c.name,
        res.changes
          ? Number(res.lastInsertRowid)
          : (db.prepare("SELECT id FROM software_catalog WHERE name = ?").get(c.name) as { id: number }).id,
      );
    }

    // алиасы: по каждому реальному имени с хостов
    const insAlias = db.prepare(
      "INSERT OR IGNORE INTO alias (norm_name, catalog_id, method, confidence, confirmed) VALUES (?, ?, 'manual', 1, 1)",
    );
    for (const raw of names) {
      const norm = normalizeName(raw);
      const corp = CORPORATE.find((c) => c.match.test(raw) && !c.exclude?.test(raw));
      let id = corp ? corpIds.get(corp.name) : undefined;
      if (id === undefined)
        for (const [cn, cid] of xlsxCatalog)
          if (norm === cn || norm.startsWith(cn + " ")) {
            id = cid;
            break;
          }
      if (id !== undefined) aliases += Number(insAlias.run(norm, id).changes);
    }
  });

  // 2) установки: каждый хост = снимок (тот же конвейер, что и у агента)
  const bySerial = new Map<string, typeof hosts>();
  for (const h of hosts) (bySerial.get(h.serial) ?? bySerial.set(h.serial, []).get(h.serial)!).push(h);
  const batchId = Number(db.prepare("INSERT INTO ingest_batch (source) VALUES ('csv')").run().lastInsertRowid); // один batch на всю выгрузку
  let i = 0;
  for (const serial of serials) {
    i++;
    applySnapshot(db, {
      serial_number: serial,
      hostname: `WS-${String(i).padStart(3, "0")}`,
      source: "csv",
      batchId,
      items: bySerial.get(serial)!.map((h) => ({ name: h.name, publisher: h.publisher, version: h.version })),
    });
  }
  db.exec("DELETE FROM install_event"); // первичная загрузка = не события
  return {
    licenseTypes: count(db, "SELECT COUNT(*) c FROM license_type"),
    catalog: count(db, "SELECT COUNT(*) c FROM software_catalog"),
    aliases,
    devices: serials.length,
    rows: hosts.length,
  };
}

/**
 * Демо-данные поверх реальных (seedBase или загрузки той же выгрузки). Только ПК из CSV-загрузок; агентские ПК не
 *   трогаются.
 * Повторно не запускается (есть сотрудники / ключи в хранилище / КриптоПро в каталоге → ошибка).
 */
export function seedDemo(db: DB): DemoStats {
  if (count(db, "SELECT COUNT(*) c FROM software_catalog") === 0)
    throw new Error("в БД нет реальных данных: сначала `make fresh` (seed из материалов)");
  if (
    count(db, "SELECT COUNT(*) c FROM employee") > 0 ||
    count(db, "SELECT COUNT(*) c FROM license_pool") > 0 ||
    count(db, "SELECT COUNT(*) c FROM software_catalog WHERE name = 'КриптоПро CSP'") > 0
  )
    throw new Error("демо-данные уже есть (сотрудники, ключи или КриптоПро): для чистого демо — `make fresh-demo`");
  const rand = rng(20261114);
  const serials = (
    db
      .prepare(
        "SELECT DISTINCT device_serial s FROM installation WHERE batch_id IN (SELECT id FROM ingest_batch WHERE source = 'csv')",
      )
      .all() as { s: string }[]
  )
    .map((r) => r.s)
    .sort(byCodeUnit);
  if (!serials.length) throw new Error("нет ПК из CSV-выгрузки — демо не к чему привязать");
  const catId = (name: string) =>
    (db.prepare("SELECT id FROM software_catalog WHERE name = ?").get(name) as { id: number } | undefined)?.id;
  let purchases = 0;

  // 1) ОС ПК (в выгрузке её нет) — тот же порядок вызовов генератора, что в прежнем seed
  tx(db, () => {
    const os = db.prepare("UPDATE device SET os = ? WHERE serial_number = ?");
    for (const sn of serials) os.run(rand() < 0.7 ? "Windows 10 Pro" : "Windows 7 Enterprise", sn);
  });

  // 2) статусы и нужные версии каталога, цены, закупки (от реального числа ПК с продуктом)
  tx(db, () => {
    for (const n of ["pgAdmin 3", "Graphviz", "Microsoft Visual Studio Express 2015 для Windows Desktop"])
      db.prepare("UPDATE software_catalog SET internal_status = 'outdated' WHERE name = ?").run(n);
    const rows = db
      .prepare(
        "SELECT device_serial, raw_name FROM installation WHERE batch_id IN (SELECT id FROM ingest_batch WHERE source = 'csv')",
      )
      .all() as { device_serial: string; raw_name: string }[];
    for (const c of CORPORATE) {
      const id = catId(c.name);
      if (id === undefined) continue;
      db.prepare("UPDATE software_catalog SET internal_status = ?, min_version = ?, list_price = ? WHERE id = ?").run(
        c.status satisfies InternalStatus,
        c.minVersion ?? null,
        c.price || null,
        id,
      );
      const devs = new Set(
        rows
          .filter((h) => !isNoise(h.raw_name) && c.match.test(h.raw_name) && !c.exclude?.test(h.raw_name))
          .map((h) => h.device_serial),
      );
      for (const p of c.purchases(devs.size)) {
        if (p.seats <= 0) continue;
        db.prepare(
          "INSERT INTO license_purchase (catalog_id, seats, unit_price, valid_until, contract) VALUES (?, ?, ?, ?, ?)",
        ).run(id, p.seats, c.price, p.until, p.contract);
        purchases++;
      }
    }
  });

  // 3) сотрудники (демо): ~95% ПК закреплены, 6 «уволенных» с ПК (основа сценария «зомби»)
  const empIds: number[] = [];
  tx(db, () => {
    const used = new Set<string>();
    const ins = db.prepare("INSERT INTO employee (full_name, department, active) VALUES (?, ?, ?)");
    const mk = (active: boolean) => {
      let n: string;
      do {
        const f = FIRST[Math.floor(rand() * FIRST.length)];
        n = `${LAST[Math.floor(rand() * LAST.length)]}${FEMALE.has(f) ? "а" : ""} ${f}`;
      } while (used.has(n));
      used.add(n);
      empIds.push(
        Number(ins.run(n, DEPARTMENTS[Math.floor(rand() * DEPARTMENTS.length)], active ? 1 : 0).lastInsertRowid),
      );
    };
    const assigned = serials.filter(() => rand() < 0.95);
    assigned.forEach((_, k) => mk(k >= 6));
    const upd = db.prepare("UPDATE device SET employee_id = ? WHERE serial_number = ?");
    assigned.forEach((s, k) => upd.run(empIds[k], s));
  });

  // 4) «последний запуск» (демо) для платного ПО, детерминированно от id:
  //    ~12% давно не запускали (100..400 дней → «зомби»), остальные — в последние 60 дней
  db.exec(`UPDATE installation SET last_used = datetime('now', '-' || (CASE WHEN (id * 37) % 100 < 12
             THEN 100 + (id * 13) % 300 ELSE (id * 7) % 60 END) || ' days')
           WHERE catalog_id IN (SELECT id FROM software_catalog WHERE license_kind IN ('commercial','shareware','trial'))`);

  // 5) лицензии Windows/Office с ПК (ДЕМО: в материалах их нет; в жизни их присылает агент из SPP/WMI).
  //    Сценарии: большинство Volume:MAK/KMS активированы; 3 ПК «не подлинная» (notification);
  //    один Retail-ключ …VK7JG на 4 ПК (key_reuse); KMS у части ПК истекает < 30 дней; 2 истёкших триала Office.
  const keyChars = "BCDFGHJKMPQRTVWXY2346789";
  const pkey = () => Array.from({ length: 5 }, () => keyChars[Math.floor(rand() * keyChars.length)]).join("");
  const at = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
  const officeDevs = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT i.device_serial FROM installation i JOIN software_catalog c ON c.id = i.catalog_id WHERE c.name = 'Microsoft Office'`,
        )
        .all() as { device_serial: string }[]
    ).map((r) => r.device_serial),
  );
  const mak = pkey();
  let licCount = 0;
  tx(db, () => {
    const ins = db.prepare(
      `INSERT INTO device_license (device_serial, application, product, description, channel, partial_key, status, status_code, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    serials.forEach((sn, k) => {
      const os = (db.prepare("SELECT os FROM device WHERE serial_number = ?").get(sn) as { os: string }).os;
      const winProduct = os.includes("Windows 7")
        ? "Windows(R) 7, Enterprise edition"
        : "Windows(R), Professional edition";
      if (k < 3)
        ins.run(
          sn,
          "windows",
          winProduct,
          "Windows(R) Operating System, RETAIL channel",
          "Retail",
          pkey(),
          "notification",
          5,
          null,
        );
      else if (k < 7)
        ins.run(
          sn,
          "windows",
          winProduct,
          "Windows(R) Operating System, RETAIL channel",
          "Retail",
          "VK7JG",
          "licensed",
          1,
          null,
        );
      else if (rand() < 0.3)
        ins.run(
          sn,
          "windows",
          winProduct,
          "Windows(R) Operating System, VOLUME_KMSCLIENT channel",
          "Volume:GVLK",
          "T83GX",
          "licensed",
          1,
          at(rand() < 0.25 ? 3 + Math.floor(rand() * 25) : 40 + Math.floor(rand() * 140)),
        );
      else
        ins.run(
          sn,
          "windows",
          winProduct,
          "Windows(R) Operating System, VOLUME_MAK channel",
          "Volume:MAK",
          mak,
          "licensed",
          1,
          null,
        );
      licCount++;
      if (officeDevs.has(sn)) {
        if (k % 50 === 11)
          ins.run(
            sn,
            "office",
            "Office 16, Office16ProPlusR_Trial edition",
            "Office 16, TIMEBASED_SUB channel",
            "Retail",
            pkey(),
            "notification",
            5,
            at(-20 - (k % 30)),
          );
        else
          ins.run(
            sn,
            "office",
            "Office 16, Office16StandardVL_KMS_Client edition",
            "Office 16, VOLUME_KMSCLIENT channel",
            "Volume:GVLK",
            "WFG99",
            "licensed",
            1,
            at(30 + Math.floor(rand() * 150)),
          );
        licCount++;
      }
    });
  });

  // 6) КриптоПро CSP (ДЕМО: в выгрузке организаторов его нет; в жизни данные шлёт агент из реестра установщика).
  //    Ключи в хранилище: A — корпоративный бессрочный на 50 мест (стоит на 48 ПК), B — годовой на 30 ПК (истекает
  // через 12 дней),
  //    C — новый годовой на 40 мест (ещё не роздан: демо «обновить ключ»). 6 ПК на пробной (одна истекла), чужой
  // ключ …Q7W2E на 3 ПК.
  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  const cpId = Number(
    db
      .prepare(
        `INSERT INTO software_catalog (name, vendor, registry_section, registry_class, license_kind, internal_status, min_version, in_ru_registry, list_price, license_type_id)
     VALUES ('КриптоПро CSP', 'ООО «КРИПТО-ПРО»', '02 - Системное программное обеспечение', '02.07 - Средства защиты информации', 'commercial', 'current', '5.0', 1, 2700, ?)`,
      )
      .run(upsertLicenseType(db, "Лицензионное соглашение КриптоПро CSP (демо)", "commercial")).lastInsertRowid,
  );
  for (const n of ["криптопро csp", "cryptopro csp"])
    // в реестре встречаются оба названия (на ВМ — «CryptoPro CSP»)
    db.prepare(
      "INSERT OR IGNORE INTO alias (norm_name, catalog_id, method, confidence, confirmed) VALUES (?, ?, 'manual', 1, 1)",
    ).run(n, cpId);
  const pool = db.prepare(
    "INSERT INTO license_pool (product, title, license_key, key_tail, seats, valid_until, license_type, note) VALUES ('cryptopro_csp', ?, ?, ?, ?, ?, ?, ?)",
  );
  pool.run(
    "КриптоПро CSP 5.0, клиентская, бессрочная",
    "40501-A0000-02ABC-DEF12-7KX2M",
    "7KX2M",
    50,
    null,
    "Клиентская",
    "Д-2023/077 (демо)",
  );
  pool.run(
    `КриптоПро CSP 5.0, клиентская, годовая до ${day(12)}`,
    "50501-B0000-03XYZ-QWE34-9PL4T",
    "9PL4T",
    30,
    day(12),
    "Клиентская, годовая",
    "Д-2025/140 (демо)",
  );
  pool.run(
    `КриптоПро CSP 5.0, клиентская, годовая до ${day(377)} (продление)`,
    "50501-C0000-04RTY-UIO56-3MN8R",
    "3MN8R",
    40,
    day(377),
    "Клиентская, годовая",
    "Д-2026/301 (демо)",
  );
  const buy = db.prepare(
    "INSERT INTO license_purchase (catalog_id, seats, unit_price, valid_until, contract) VALUES (?, ?, 2700, ?, ?)",
  );
  buy.run(cpId, 50, null, "Д-2023/077");
  buy.run(cpId, 30, day(12), "Д-2025/140");
  buy.run(cpId, 40, day(377), "Д-2026/301");
  const cpDevs = serials.slice(10, 97); // 87 ПК
  const instCp = db.prepare(
    `INSERT INTO installation (device_serial, raw_name, raw_publisher, raw_version, norm_name, catalog_id, match_method, match_score, last_used, install_location)
     VALUES (?, 'КриптоПро CSP', 'Компания КРИПТО-ПРО', '5.0.12000', 'криптопро csp', ?, 'alias', 1, datetime('now', '-' || ? || ' days'), 'C:\\Program Files\\Crypto Pro\\CSP\\')`,
  );
  const licCp = db.prepare(
    `INSERT INTO device_license (device_serial, application, product, description, channel, partial_key, status, status_code, expires_at)
     VALUES (?, 'cryptopro_csp', 'КриптоПро CSP 5.0.12000', ?, ?, ?, ?, NULL, ?)`,
  );
  tx(db, () =>
    cpDevs.forEach((sn, k) => {
      instCp.run(sn, cpId, k % 20);
      if (k < 48) licCp.run(sn, "Постоянная", "Клиентская", "7KX2M", "licensed", null);
      else if (k < 78)
        licCp.run(sn, `Истекает ${day(12)}`, "Клиентская, годовая", "9PL4T", "licensed", `${day(12)} 23:59:59`);
      else if (k < 84)
        licCp.run(
          sn,
          "Демонстрационная",
          "Пробная",
          null,
          k === 78 ? "expired" : "trial",
          k === 78 ? `${day(-3)} 23:59:59` : `${day(5 + (k - 79) * 15)} 23:59:59`,
        );
      else licCp.run(sn, "Постоянная", "Клиентская", "Q7W2E", "licensed", null);
      licCount++;
    }),
  );

  return { deviceLicenses: licCount, employees: empIds.length, purchases, devices: serials.length };
}

/** Реальное + демо (как раньше один seed): тесты и `make fresh-demo`. */
export async function seed(db: DB): Promise<SeedStats> {
  const base = await seedBase(db);
  return { ...base, ...seedDemo(db) };
}
