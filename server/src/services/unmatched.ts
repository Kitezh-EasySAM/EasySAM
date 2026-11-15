/**
 * Очередь «Неопознанное»: нераспознанные установки, сгруппированные по нормализованному имени,
 * с подсказками нечёткого сравнения; привязка к каталогу (→ alias) и «игнорировать» (→ ignored_name, шум).
 * Автопривязки нет НАМЕРЕННО: калибровка на реальных данных показала, что даже при score ≥ 0.95
 * кандидаты — родственные компоненты/другие лицензии (AutoCAD Architecture, плагины Kaspersky),
 * а привязка влияет на подсчёт лицензий. Решает человек (позже — подсказка ИИ).
 * Тесты: test/unmatched.test.ts
 */
import { likeContains, tx, type DB } from "../db.ts";
import { suggest, type Candidate, type Suggestion } from "./fuzzy.ts";
import { normalizeName, normalizePublisher } from "./normalize.ts";

/** Имена, помеченные «не учитывать». */
export function loadIgnored(db: DB): Set<string> {
  return new Set(
    (db.prepare("SELECT norm_name FROM ignored_name").all() as { norm_name: string }[]).map((r) => r.norm_name),
  );
}

/** Кандидаты для нечётких подсказок: имена каталога и выученные alias. */
export function loadCandidates(db: DB): Candidate[] {
  const out: Candidate[] = [];
  for (const c of db.prepare("SELECT id, name, vendor FROM software_catalog").all() as {
    id: number;
    name: string;
    vendor: string | null;
  }[])
    out.push({
      catalogId: c.id,
      catalogName: c.name,
      norm: normalizeName(c.name),
      vendor: normalizePublisher(c.vendor),
    });
  for (const a of db
    .prepare("SELECT a.norm_name, c.id, c.name, c.vendor FROM alias a JOIN software_catalog c ON c.id = a.catalog_id")
    .all() as { norm_name: string; id: number; name: string; vendor: string | null }[])
    out.push({ catalogId: a.id, catalogName: a.name, norm: a.norm_name, vendor: normalizePublisher(a.vendor) });
  return out;
}

export interface UnmatchedGroup {
  norm_name: string;
  example_raw_name: string;
  publisher: string | null;
  devices: number;
  installations: number;
  suggestions: Suggestion[];
}

/** Неопознанные установки, сгруппированные по имени, с подсказками; самые массовые первыми. */
export function listUnmatched(db: DB, opts: { q?: string; limit: number; offset: number }) {
  const like = likeContains(opts.q);
  const where = "WHERE catalog_id IS NULL AND is_noise = 0 AND (? IS NULL OR norm_name LIKE ? ESCAPE '\\')";
  const totals = db
    .prepare(
      `SELECT COUNT(DISTINCT norm_name) AS groups, COUNT(*) AS installations, COUNT(DISTINCT device_serial) AS devices FROM installation ${where}`,
    )
    .get(like, like) as { groups: number; installations: number; devices: number };
  const rows = db
    .prepare(
      `SELECT norm_name, MIN(raw_name) AS example_raw_name, MAX(raw_publisher) AS publisher,
       COUNT(DISTINCT device_serial) AS devices, COUNT(*) AS installations
     FROM installation ${where} GROUP BY norm_name ORDER BY devices DESC, norm_name LIMIT ? OFFSET ?`,
    )
    .all(like, like, opts.limit, opts.offset) as Omit<UnmatchedGroup, "suggestions">[];
  const cands = loadCandidates(db);
  const items: UnmatchedGroup[] = rows.map((r) => ({ ...r, suggestions: suggest(r.norm_name, r.publisher, cands) }));
  return { total: totals.groups, total_installations: totals.installations, total_devices: totals.devices, items };
}

/** Привязать группы к позиции каталога: запоминаем alias (confirmed) и обновляем установки. */
export function resolveToCatalog(db: DB, normNames: string[], catalogId: number): number {
  return tx(db, () => {
    const alias = db.prepare(
      `INSERT INTO alias (norm_name, catalog_id, method, confidence, confirmed) VALUES (?, ?, 'manual', 1, 1)
       ON CONFLICT(norm_name) DO UPDATE SET catalog_id = excluded.catalog_id, method = 'manual', confidence = 1, confirmed = 1`,
    );
    const upd = db.prepare(
      "UPDATE installation SET catalog_id = ?, match_method = 'manual', match_score = 1 WHERE norm_name = ? AND catalog_id IS NULL AND is_noise = 0",
    );
    const unignore = db.prepare("DELETE FROM ignored_name WHERE norm_name = ?");
    let n = 0;
    for (const nm of normNames) {
      alias.run(nm, catalogId);
      unignore.run(nm);
      n += Number(upd.run(catalogId, nm).changes);
    }
    return n;
  });
}

/** «Не учитывать»: компонент/плагин/системная утилита → шум сейчас и при будущих загрузках. */
export function ignoreNames(db: DB, normNames: string[]): number {
  return tx(db, () => {
    const ins = db.prepare("INSERT OR IGNORE INTO ignored_name (norm_name) VALUES (?)");
    const upd = db.prepare("UPDATE installation SET is_noise = 1 WHERE norm_name = ? AND catalog_id IS NULL");
    let n = 0;
    for (const nm of normNames) {
      ins.run(nm);
      n += Number(upd.run(nm).changes);
    }
    return n;
  });
}
