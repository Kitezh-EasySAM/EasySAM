/**
 * «Добавить в одобренное ПО» по итогам проверки лицензии: позиция каталога + соглашение (license_type с анализом),
 * точные совпадения из «Неопознанного» привязываются сразу (нечёткие — нет, инвариант DATA_MODEL). Тесты:
 *   test/eula.test.ts
 */
import { tx, type DB } from "../db.ts";
import type { CommercialUse, LicenseKind } from "./eula.ts";
import { normalizeName } from "./normalize.ts";
import { resolveToCatalog } from "./unmatched.ts";

export interface ApproveInput {
  name: string;
  vendor?: string | null;
  purpose?: string | null;
  license_kind: LicenseKind;
  internal_status: "current" | "outdated" | "forbidden";
  license_name?: string | null;
  commercial_use?: CommercialUse;
  copyleft?: boolean | null;
  min_version?: string | null;
  analysis?: unknown;
}

/**
 * Создать/обновить позицию каталога и соглашение (license_type с анализом); точные совпадения «Неопознанного»
 * привязать.
 */
export function approveSoftware(
  db: DB,
  a: ApproveInput,
): { catalog_id: number; created: boolean; license_type_id: number | null; linked_installations: number } {
  return tx(db, () => {
    let ltId: number | null = null;
    if (a.license_name) {
      const lt = db.prepare("SELECT id FROM license_type WHERE ulower(name) = ?").get(a.license_name.toLowerCase()) as
        { id: number } | undefined;
      const cu = a.commercial_use === "allowed" ? 1 : a.commercial_use === "forbidden" ? 0 : null;
      const analysis = a.analysis === undefined ? null : JSON.stringify(a.analysis).slice(0, 50_000);
      if (lt) {
        ltId = lt.id;
        db.prepare(
          `UPDATE license_type SET eula_analysis = COALESCE(?, eula_analysis),
             commercial_use = COALESCE(commercial_use, ?), copyleft = COALESCE(copyleft, ?) WHERE id = ?`,
        ).run(analysis, cu, a.copyleft == null ? null : a.copyleft ? 1 : 0, lt.id);
      } else {
        ltId = Number(
          db
            .prepare(
              "INSERT INTO license_type (name, kind, commercial_use, copyleft, eula_analysis) VALUES (?, ?, ?, ?, ?)",
            )
            .run(a.license_name, a.license_kind, cu, a.copyleft == null ? null : a.copyleft ? 1 : 0, analysis)
            .lastInsertRowid,
        );
      }
    }
    const ex = db.prepare("SELECT id FROM software_catalog WHERE ulower(name) = ?").get(a.name.toLowerCase()) as
      { id: number } | undefined;
    let id: number;
    if (ex) {
      id = ex.id;
      db.prepare(
        `UPDATE software_catalog SET vendor = COALESCE(?, vendor), purpose = COALESCE(?, purpose), license_kind = ?, internal_status = ?,
        license_type_id = COALESCE(?, license_type_id), min_version = COALESCE(?, min_version) WHERE id = ?`,
      ).run(a.vendor ?? null, a.purpose ?? null, a.license_kind, a.internal_status, ltId, a.min_version ?? null, id);
    } else {
      id = Number(
        db
          .prepare(
            "INSERT INTO software_catalog (name, vendor, purpose, license_kind, internal_status, license_type_id, min_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            a.name,
            a.vendor ?? null,
            a.purpose ?? null,
            a.license_kind,
            a.internal_status,
            ltId,
            a.min_version ?? null,
          ).lastInsertRowid,
      );
    }
    // только ТОЧНОЕ совпадение нормализованного имени (нечёткое — лишь подсказкой в «Неопознанном», инвариант
    // DATA_MODEL)
    const norm = normalizeName(a.name);
    const exact = (
      db
        .prepare(
          "SELECT DISTINCT norm_name FROM installation WHERE catalog_id IS NULL AND is_noise = 0 AND norm_name = ?",
        )
        .all(norm) as { norm_name: string }[]
    ).map((r) => r.norm_name);
    const linked = exact.length ? resolveToCatalog(db, exact, id) : 0;
    return { catalog_id: id, created: !ex, license_type_id: ltId, linked_installations: linked };
  });
}
