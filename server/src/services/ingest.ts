/**
 * Конвейер загрузки: шум → нормализация → матчинг → запись → события.
 * Вход один для всех коннекторов (агент, CSV, ручной ввод). Тесты: test/ingest.test.ts.
 * Семантика:
 *  - applySnapshot = ПОЛНЫЙ снимок устройства: старые installation заменяются (идемпотентно);
 *    если у устройства уже был снимок, разница пишется в install_event (installed/removed/updated).
 *  - applyEvents = инкремент от постоянно работающего агента: меняет installation и пишет события.
 * Матчинг при загрузке: exact (имя каталога) и alias (в т.ч. подтверждённые человеком). Нечёткие подсказки
 * НЕ применяются автоматически — см. services/unmatched.ts. Имена из ignored_name считаются шумом.
 */
import type { DB } from "../db.ts";
import { tx } from "../db.ts";
import { isNoise, normalizeName } from "./normalize.ts";
import { publishAgentTouch } from "./stream.ts";
import { loadIgnored } from "./unmatched.ts";

export interface RawItem {
  name: string;
  publisher?: string | null;
  version?: string | null;
  install_date?: string | null;
  install_location?: string | null; // папка программы — для связи с запущенными процессами
}
export interface DeviceMeta {
  serial_number: string;
  hostname?: string | null;
  os?: string | null;
}
export interface Snapshot extends DeviceMeta {
  items: RawItem[];
  source?: "agent" | "csv" | "manual";
  batchId?: number; // общий batch на файл (CSV): счётчики суммируются; иначе создаётся свой
}
export interface AgentEvent {
  type: "installed" | "removed" | "updated";
  name: string;
  publisher?: string | null;
  old_version?: string | null;
  new_version?: string | null;
  at?: string;
}
export interface SnapshotStats {
  batchId: number;
  rowsTotal: number;
  rowsNoise: number;
  rowsMatched: number;
  rowsUnknown: number;
  events: number;
}

type Match = { catalogId: number; method: "exact" | "alias" } | null;

/** Сопоставитель нормализованного имени с каталогом (точное имя, затем выученный alias); null — не нашли. */
export function buildMatcher(db: DB): (norm: string) => Match {
  const catalog = new Map<string, number>();
  for (const r of db.prepare("SELECT id, name FROM software_catalog").all() as { id: number; name: string }[])
    catalog.set(normalizeName(r.name), r.id);
  const alias = new Map<string, number>();
  for (const r of db.prepare("SELECT norm_name, catalog_id FROM alias").all() as {
    norm_name: string;
    catalog_id: number;
  }[])
    alias.set(r.norm_name, r.catalog_id);
  return (norm) => {
    const a = alias.get(norm);
    if (a !== undefined) return { catalogId: a, method: "alias" };
    const c = catalog.get(norm);
    return c !== undefined ? { catalogId: c, method: "exact" } : null;
  };
}

function upsertDevice(db: DB, d: DeviceMeta) {
  db.prepare(
    `INSERT INTO device (serial_number, hostname, os, last_seen) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(serial_number) DO UPDATE SET hostname = COALESCE(excluded.hostname, hostname),
       os = COALESCE(excluded.os, os), last_seen = datetime('now')`,
  ).run(d.serial_number, d.hostname ?? null, d.os ?? null);
}

/** Отметить контакт агента (снимок, события, процессы, опрос заданий) → статус «в сети» + SSE «agent» для борды. */
export function touchAgent(db: DB, serial: string) {
  db.prepare("UPDATE device SET agent_last_seen = datetime('now') WHERE serial_number = ?").run(serial);
  publishAgentTouch(serial);
}

/** SQL-выражение статуса агента по device d: online | offline (≤ 7 дней) | lost (> 7 дней) | no_agent. */
export const AGENT_STATUS_SQL = (onlineSeconds: number) => `CASE
  WHEN d.agent_last_seen IS NULL THEN 'no_agent'
  WHEN d.agent_last_seen >= datetime('now', '-${Math.max(1, Math.floor(onlineSeconds))} seconds') THEN 'online'
  WHEN d.agent_last_seen >= datetime('now', '-7 days') THEN 'offline'
  ELSE 'lost' END`;

const keyOf = (name: string, publisher?: string | null) => `${name}\u0000${publisher ?? ""}`;

/** Полный снимок ПО одного ПК: заменяет его установки, разницу пишет событиями; идемпотентен. */
export function applySnapshot(db: DB, snap: Snapshot): SnapshotStats {
  return tx(db, () => {
    upsertDevice(db, snap);
    const match = buildMatcher(db);
    const ignored = loadIgnored(db); // помеченные человеком «не учитывать» = шум
    const serial = snap.serial_number;

    const prev = db
      .prepare(
        "SELECT raw_name, raw_publisher, raw_version, catalog_id, is_noise, last_used FROM installation WHERE device_serial = ?",
      )
      .all(serial) as {
      raw_name: string;
      raw_publisher: string | null;
      raw_version: string | null;
      catalog_id: number | null;
      is_noise: number;
      last_used: string | null;
    }[];
    const prevMap = new Map(prev.map((r) => [keyOf(r.raw_name, r.raw_publisher), r]));

    // дедуп внутри снимка (Java 8 и Java 8 (64-bit) — разные имена, но одинаковые строки схлопываем)
    const items = new Map<string, RawItem>();
    for (const it of snap.items)
      if (it.name?.trim()) items.set(`${keyOf(it.name.trim(), it.publisher)}\u0000${it.version ?? ""}`, it);

    const batchId =
      snap.batchId ??
      Number(db.prepare("INSERT INTO ingest_batch (source) VALUES (?)").run(snap.source ?? "agent").lastInsertRowid);
    db.prepare("DELETE FROM installation WHERE device_serial = ?").run(serial);
    const ins = db.prepare(
      `INSERT INTO installation (device_serial, batch_id, raw_name, raw_publisher, raw_version, norm_name,
         is_noise, catalog_id, match_method, match_score, last_used, install_location) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let noise = 0,
      matched = 0,
      unknown = 0;
    const next = new Map<
      string,
      { version: string | null; catalogId: number | null; name: string; publisher: string | null; noise: boolean }
    >();
    for (const it of items.values()) {
      const name = it.name.trim();
      const norm = normalizeName(name);
      const n = isNoise(name) || ignored.has(norm);
      const m = n ? null : match(norm);
      if (n) noise++;
      else if (m) matched++;
      else unknown++;
      const k = keyOf(name, it.publisher);
      // last_used переносим из прошлого снимка: снимок не знает о запусках, терять их нельзя
      ins.run(
        serial,
        batchId,
        name,
        it.publisher ?? null,
        it.version ?? null,
        norm,
        n ? 1 : 0,
        m?.catalogId ?? null,
        m?.method ?? null,
        m ? 1 : null,
        prevMap.get(k)?.last_used ?? null,
        it.install_location?.trim() || null,
      );
      next.set(k, {
        version: it.version ?? null,
        catalogId: m?.catalogId ?? null,
        name,
        publisher: it.publisher ?? null,
        noise: n,
      });
    }
    db.prepare(
      `UPDATE ingest_batch SET rows_total = rows_total + ?, rows_noise = rows_noise + ?,
         rows_matched = rows_matched + ?, rows_unknown = rows_unknown + ? WHERE id = ?`,
    ).run(items.size, noise, matched, unknown, batchId);

    let events = 0;
    if (prev.length > 0) {
      const ev = db.prepare(
        `INSERT INTO install_event (device_serial, type, raw_name, raw_publisher, old_version, new_version, catalog_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      // шум (KB-обновления, Redistributable…) в ленту событий не пишем — иначе она бесполезна
      for (const [k, v] of next) {
        if (v.noise) continue;
        const o = prevMap.get(k);
        if (!o) {
          ev.run(serial, "installed", v.name, v.publisher, null, v.version, v.catalogId);
          events++;
        } else if ((o.raw_version ?? null) !== v.version) {
          ev.run(serial, "updated", v.name, v.publisher, o.raw_version, v.version, v.catalogId);
          events++;
        }
      }
      for (const [k, o] of prevMap)
        if (!o.is_noise && !next.has(k)) {
          ev.run(serial, "removed", o.raw_name, o.raw_publisher, o.raw_version, null, o.catalog_id);
          events++;
        }
    }
    return { batchId, rowsTotal: items.size, rowsNoise: noise, rowsMatched: matched, rowsUnknown: unknown, events };
  });
}

/** Инкремент от агента (установили / удалили / обновили) для одного ПК. */
export function applyEvents(db: DB, dev: DeviceMeta, events: AgentEvent[]): { applied: number } {
  return tx(db, () => {
    upsertDevice(db, dev);
    const match = buildMatcher(db);
    const ignored = loadIgnored(db);
    const serial = dev.serial_number;
    const evIns = db.prepare(
      `INSERT INTO install_event (device_serial, type, raw_name, raw_publisher, old_version, new_version, catalog_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(datetime(?), datetime('now')))`, // datetime(): ISO от агента → единый формат SQLite
    );
    const WHERE = "device_serial = ? AND raw_name = ? AND COALESCE(raw_publisher,'') = ?";
    const find = db.prepare(`SELECT catalog_id, is_noise FROM installation WHERE ${WHERE}`);
    const del = db.prepare(`DELETE FROM installation WHERE ${WHERE}`);
    const upd = db.prepare(`UPDATE installation SET raw_version = ? WHERE ${WHERE}`);
    const ins = db.prepare(
      `INSERT INTO installation (device_serial, raw_name, raw_publisher, raw_version, norm_name, is_noise, catalog_id, match_method, match_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let applied = 0;
    for (const e of events) {
      const name = e.name.trim();
      const pub = e.publisher ?? null;
      const row = find.get(serial, name, pub ?? "") as { catalog_id: number | null; is_noise: number } | undefined;
      let catalogId = row?.catalog_id ?? null,
        noise = !!row?.is_noise;
      // installed, а также updated/«неизвестная нам» позиция → (пере)создаём строку
      if (e.type === "installed" || (e.type === "updated" && !row)) {
        const norm = normalizeName(name),
          n = isNoise(name) || ignored.has(norm),
          m = n ? null : match(norm);
        del.run(serial, name, pub ?? "");
        ins.run(
          serial,
          name,
          pub,
          e.new_version ?? null,
          norm,
          n ? 1 : 0,
          m?.catalogId ?? null,
          m?.method ?? null,
          m ? 1 : null,
        );
        catalogId = m?.catalogId ?? null;
        noise = n;
      } else if (e.type === "removed") del.run(serial, name, pub ?? "");
      else upd.run(e.new_version ?? null, serial, name, pub ?? "");
      if (!noise)
        evIns.run(serial, e.type, name, pub, e.old_version ?? null, e.new_version ?? null, catalogId, e.at ?? null);
      applied++;
    }
    return { applied };
  });
}

/** Пересопоставить нераспознанные установки после изменения каталога/алиасов. Возвращает число привязанных. */
export function rematchUnknown(db: DB): number {
  const match = buildMatcher(db);
  const rows = db.prepare("SELECT id, norm_name FROM installation WHERE catalog_id IS NULL AND is_noise = 0").all() as {
    id: number;
    norm_name: string;
  }[];
  const upd = db.prepare("UPDATE installation SET catalog_id = ?, match_method = ?, match_score = 1 WHERE id = ?");
  return tx(db, () => {
    let n = 0;
    for (const r of rows) {
      const m = match(r.norm_name);
      if (m) {
        upd.run(m.catalogId, m.method, r.id);
        n++;
      }
    }
    return n;
  });
}
