/**
 * Запущенные процессы (от агента): сопоставление с программами, «последний запуск», неустановленное ПО.
 * Порядок сопоставления (от надёжного к менее надёжному):
 *   installer — установщик/деинсталлятор (setup.exe, *-setup.exe, unins000.exe, ProductName «… Setup»): не
 *   программа, не portable;
 *   path    — exe лежит в install_location установленной на этом ПК программы;
 *   installed — ProductName exe = название установленной на этом ПК программы (OneDrive: ставится «для пользователя»
 *             без InstallLocation, путь в AppData);
 *   exe     — словарь известных exe (winword.exe → Microsoft Office…), если такая позиция есть в каталоге;
 *   product — ProductName из VERSIONINFO exe → exact/alias как у установок;
 *   fuzzy   — ProductName нечётко, только при score ≥ 0.9.
 * portable = запущено, но на этом ПК не установлено (нет связи по пути и нет установки той же позиции каталога)
 *            и не из Program Files — теневое/переносное ПО (ИБ и лицензионный риск).
 * Эффект: installation.last_used = max(last_used, last_seen) → «зомби» считается по реальным запускам.
 * Тесты: test/processes.test.ts
 */
import type { DB } from "../db.ts";
import { tx } from "../db.ts";
import { buildContext, matchProcess, SYSTEM_EXE, SYSTEM_PATH, winPath } from "./processMatch.ts";
export { isInstaller, matchProcess, type ProcMatch } from "./processMatch.ts";

export interface ProcIn {
  exe: string;
  path?: string | null;
  product_name?: string | null;
  company?: string | null;
  file_version?: string | null;
  first_seen: string;
  last_seen: string;
  samples?: number;
}

export interface ProcessAlert {
  exe: string;
  path: string | null;
  catalog_name: string | null;
  reason: "forbidden_running" | "portable";
  level: "red" | "yellow";
  text: string;
}

const toSql = (s: string) => {
  const t = Date.parse(s);
  return Number.isNaN(t)
    ? new Date().toISOString().slice(0, 19).replace("T", " ")
    : new Date(t).toISOString().slice(0, 19).replace("T", " ");
};

/** Принять отчёт агента: upsert агрегата, обновить last_used установок, вернуть алерты по НОВЫМ фактам. */
export function applyUsage(db: DB, serial: string, procs: ProcIn[]): { accepted: number; alerts: ProcessAlert[] } {
  return tx(db, () => {
    const ctx = buildContext(db, serial);
    const meta = db
      .prepare(
        "SELECT d.hostname, e.full_name AS employee FROM device d LEFT JOIN employee e ON e.id = d.employee_id WHERE d.serial_number = ?",
      )
      .get(serial) as { hostname: string | null; employee: string | null };
    const where = `${meta.hostname ?? serial}${meta.employee ? ` (${meta.employee})` : ""}`;
    const prevStmt = db.prepare("SELECT last_seen FROM process_usage WHERE device_serial = ? AND path_key = ?");
    const upsert = db.prepare(
      `INSERT INTO process_usage (device_serial, path_key, exe_name, exe_path, product_name, company, file_version,
         catalog_id, installation_name, match_method, portable, first_seen, last_seen, samples)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_serial, path_key) DO UPDATE SET
         exe_name = excluded.exe_name, product_name = COALESCE(excluded.product_name, product_name),
         company = COALESCE(excluded.company, company), file_version = COALESCE(excluded.file_version, file_version),
         catalog_id = excluded.catalog_id, installation_name = excluded.installation_name, match_method = excluded.match_method,
         portable = excluded.portable, first_seen = MIN(first_seen, excluded.first_seen),
         last_seen = MAX(last_seen, excluded.last_seen), samples = samples + excluded.samples`,
    );
    const touchCatalog = db.prepare(
      "UPDATE installation SET last_used = ? WHERE device_serial = ? AND catalog_id = ? AND (last_used IS NULL OR last_used < ?)",
    );
    const touchByName = db.prepare(
      "UPDATE installation SET last_used = ? WHERE device_serial = ? AND raw_name = ? AND (last_used IS NULL OR last_used < ?)",
    );
    const catInfo = db.prepare("SELECT name, internal_status FROM software_catalog WHERE id = ?");
    const alerts: ProcessAlert[] = [];
    for (const p of procs) {
      // защита от старого/ошибившегося агента: системные пути и системные процессы без пути
      if (p.path ? SYSTEM_PATH.test(winPath(p.path)) : SYSTEM_EXE.has(p.exe.toLowerCase())) continue;
      const key = (p.path ?? p.exe).toLowerCase();
      const first = toSql(p.first_seen),
        last = toSql(p.last_seen);
      const prev = prevStmt.get(serial, key) as { last_seen: string } | undefined;
      const m = matchProcess(db, serial, p, ctx);
      upsert.run(
        serial,
        key,
        p.exe,
        p.path ?? null,
        p.product_name ?? null,
        p.company ?? null,
        p.file_version ?? null,
        m.catalog_id,
        m.installation_name,
        m.method,
        m.portable ? 1 : 0,
        first,
        last,
        p.samples ?? 1,
      );
      if (m.catalog_id !== null) touchCatalog.run(last, serial, m.catalog_id, last);
      else if (m.installation_name) touchByName.run(last, serial, m.installation_name, last);

      const cat =
        m.catalog_id !== null ? (catInfo.get(m.catalog_id) as { name: string; internal_status: string }) : null;
      // запрещённое: если раньше не видели или не видели больше часа (новый «сеанс»)
      const newSession =
        !prev ||
        Date.parse(last.replace(" ", "T") + "Z") - Date.parse(prev.last_seen.replace(" ", "T") + "Z") > 3_600_000;
      if (cat?.internal_status === "forbidden" && newSession)
        alerts.push({
          exe: p.exe,
          path: p.path ?? null,
          catalog_name: cat.name,
          reason: "forbidden_running",
          level: "red",
          text: `Запущено запрещённое ПО «${cat.name}» (${p.exe}) на ${where}`,
        });
      else if (m.portable && !prev)
        alerts.push({
          exe: p.exe,
          path: p.path ?? null,
          catalog_name: cat?.name ?? null,
          reason: "portable",
          level: "yellow",
          text: `Запущено неустановленное ПО «${p.product_name || p.exe}»${p.path ? ` из ${p.path}` : ""} на ${where}`,
        });
    }
    return { accepted: procs.length, alerts };
  });
}

/** Пересчитать сопоставление всех сохранённых процессов (правила поменялись / каталог изменился). Без алертов. */
export function rematchAllProcesses(db: DB): number {
  const rows = db
    .prepare(
      "SELECT id, device_serial, exe_name, exe_path, product_name, company, first_seen, last_seen FROM process_usage",
    )
    .all() as {
    id: number;
    device_serial: string;
    exe_name: string;
    exe_path: string | null;
    product_name: string | null;
    company: string | null;
    first_seen: string;
    last_seen: string;
  }[];
  const upd = db.prepare(
    "UPDATE process_usage SET catalog_id = ?, installation_name = ?, match_method = ?, portable = ? WHERE id = ?",
  );
  const ctxs = new Map<string, ReturnType<typeof buildContext>>();
  return tx(db, () => {
    let changed = 0;
    for (const r of rows) {
      if (!ctxs.has(r.device_serial)) ctxs.set(r.device_serial, buildContext(db, r.device_serial));
      const m = matchProcess(
        db,
        r.device_serial,
        {
          exe: r.exe_name,
          path: r.exe_path,
          product_name: r.product_name,
          company: r.company,
          first_seen: r.first_seen,
          last_seen: r.last_seen,
        },
        ctxs.get(r.device_serial),
      );
      changed += Number(upd.run(m.catalog_id, m.installation_name, m.method, m.portable ? 1 : 0, r.id).changes);
    }
    return changed;
  });
}

/** Запущенные программы (все или одного ПК) со сводкой и фильтром portable / unmatched / forbidden. */
export function listProcesses(db: DB, f: { device?: string; filter?: string; limit?: number }) {
  const rows = db
    .prepare(
      `SELECT p.*, d.hostname, e.full_name AS employee, c.name AS catalog_name, c.internal_status, c.license_kind
     FROM process_usage p JOIN device d ON d.serial_number = p.device_serial
     LEFT JOIN employee e ON e.id = d.employee_id LEFT JOIN software_catalog c ON c.id = p.catalog_id
     WHERE (? IS NULL OR p.device_serial = ?) ORDER BY p.last_seen DESC`,
    )
    .all(f.device ?? null, f.device ?? null) as Record<string, unknown>[];
  const items = rows
    .map((r) => ({ ...r, portable: !!r.portable }) as Record<string, unknown>)
    .filter(
      (r) =>
        !f.filter ||
        (f.filter === "portable" && r.portable) ||
        (f.filter === "unmatched" && r.catalog_id === null) ||
        (f.filter === "forbidden" && r.internal_status === "forbidden"),
    )
    .slice(0, f.limit ?? 500); // сводка ниже — по всем строкам
  return {
    summary: {
      total: rows.length,
      devices: new Set(rows.map((r) => r.device_serial)).size,
      matched: rows.filter((r) => r.catalog_id !== null).length,
      unmatched: rows.filter((r) => r.catalog_id === null).length,
      // связано с программой, установленной на ПК (даже если её нет в каталоге), или это установщик
      linked: rows.filter((r) => r.catalog_id !== null || r.installation_name !== null).length,
      installers: rows.filter((r) => r.match_method === "installer").length,
      portable: rows.filter((r) => r.portable).length,
      forbidden_running: rows.filter((r) => r.internal_status === "forbidden").length,
    },
    items,
  };
}
