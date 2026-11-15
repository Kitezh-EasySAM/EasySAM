import { test } from "node:test";
import assert from "node:assert/strict";
import { compute, summarize, type CatalogInfo } from "../src/services/compliance.ts";

const item = (o: Partial<CatalogInfo> = {}): CatalogInfo => ({
  id: 1,
  name: "X",
  licenseKind: "commercial",
  internalStatus: "current",
  seats: 100,
  unitPrice: 1000,
  installed: 100,
  outdatedInstalled: 0,
  ...o,
});

test("превышение = красный + штраф", () => {
  const [r] = compute([item({ name: "MS Office", installed: 120, unitPrice: 15000 })]);
  assert.deepEqual([r.status, r.severity, r.deficit, r.penalty], ["over", "red", 20, 300000]);
});
test("баланс сходится = ok", () => {
  const [r] = compute([item()]);
  assert.deepEqual([r.status, r.deficit, r.idle], ["ok", 0, 0]);
});
test("простой = waste, не штраф", () => {
  const [r] = compute([item({ seats: 30, installed: 25, unitPrice: 100 })]);
  assert.deepEqual([r.status, r.idle, r.waste, r.penalty], ["idle", 5, 500, 0]);
});
test("бесплатное без дефицита даже при 0 мест", () => {
  const [r] = compute([item({ licenseKind: "open_source", seats: 0, installed: 50 })]);
  assert.deepEqual([r.status, r.deficit], ["ok", 0]);
});
test("запрещённое красное только если установлено", () => {
  const [a] = compute([item({ internalStatus: "forbidden", installed: 2, seats: 0 })]);
  const [b] = compute([item({ internalStatus: "forbidden", installed: 0, seats: 0 })]);
  assert.equal(a.status, "forbidden");
  assert.notEqual(b.status, "forbidden");
});
test("коммерческое без закупки = over", () => {
  const [r] = compute([item({ seats: 0, installed: 2, unitPrice: 5000 })]);
  assert.deepEqual([r.status, r.penalty], ["over", 10000]);
});
test("устаревшая версия = жёлтый", () => {
  const [r] = compute([item({ outdatedInstalled: 3 })]);
  assert.deepEqual([r.status, r.severity], ["outdated", "yellow"]);
});
test("сортировка: красное первым; сводка", () => {
  const rows = compute([item({ id: 1, name: "ok" }), item({ id: 2, name: "bad", installed: 110 })]);
  assert.equal(rows[0].name, "bad");
  const s = summarize(rows);
  assert.deepEqual([s.red, s.green, s.totalPenalty], [1, 1, 10000]);
});

test("зомби: считаются только у платного ПО и дают reclaimable, статус не меняют", () => {
  const [a] = compute([item({ zombie: 4, unitPrice: 1000 })]);
  assert.deepEqual([a.status, a.zombie, a.reclaimable], ["ok", 4, 4000]);
  const [b] = compute([item({ licenseKind: "freeware", zombie: 4 })]);
  assert.deepEqual([b.zombie, b.reclaimable], [0, 0]);
});

test("зомби: программу ни разу не запускали, хотя за процессами ПК наблюдаем дольше STALE_DAYS", async () => {
  const { openDb } = await import("../src/db.ts");
  const { complianceReport } = await import("../src/services/report.ts");
  const db = openDb(":memory:");
  const id = Number(
    db
      .prepare("INSERT INTO software_catalog (name, license_kind, list_price) VALUES ('Платная', 'commercial', 1000)")
      .run().lastInsertRowid,
  );
  const pc = db.prepare("INSERT INTO device (serial_number) VALUES (?)");
  const inst = db.prepare(
    "INSERT INTO installation (device_serial, raw_name, norm_name, catalog_id) VALUES (?, 'Платная', 'платная', ?)",
  );
  const proc = db.prepare(
    "INSERT INTO process_usage (device_serial, path_key, exe_name, first_seen, last_seen) VALUES (?, 'other.exe', 'other.exe', datetime('now', ?), datetime('now'))",
  );
  for (const s of ["OLD", "NEW", "FILE"]) {
    pc.run(s);
    inst.run(s, id);
  }
  proc.run("OLD", "-200 days"); // наблюдаем давно, «Платную» не запускали → зомби
  proc.run("NEW", "-5 days"); // агент стоит недавно → рано судить
  // FILE — данные из файла, процессов нет → не зомби
  const row = complianceReport(db).rows.find((r) => r.catalog_id === id)!;
  assert.deepEqual([row.installed, row.zombie, row.reclaimable], [3, 1, 1000]);
});
