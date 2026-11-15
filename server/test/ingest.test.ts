import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { applyEvents, applySnapshot } from "../src/services/ingest.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;

function seeded() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO software_catalog (id, name, license_kind, internal_status) VALUES
    (1, '7-Zip', 'open_source', 'current'), (2, 'WinRAR', 'shareware', 'forbidden'), (3, 'Google Chrome', 'freeware', 'current')`);
  return db;
}
const dev = { serial_number: "SN1", hostname: "PC1", os: "Windows 10" };

test("снимок: шум, совпадения, неизвестное", () => {
  const db = seeded();
  const s = applySnapshot(db, {
    ...dev,
    items: [
      { name: "7-Zip 19.00 (x64 edition)", publisher: "Igor Pavlov", version: "19.00" },
      { name: "Microsoft Visual C++ 2013 Redistributable (x64)" },
      { name: "Strange Tool 1.0" },
    ],
  });
  assert.deepEqual([s.rowsTotal, s.rowsNoise, s.rowsMatched, s.rowsUnknown, s.events], [3, 1, 1, 1, 0]);
});

test("повторный снимок идемпотентен и порождает события diff", () => {
  const db = seeded();
  applySnapshot(db, {
    ...dev,
    items: [
      { name: "7-Zip", version: "19" },
      { name: "WinRAR", version: "4" },
    ],
  });
  const again = applySnapshot(db, {
    ...dev,
    items: [
      { name: "7-Zip", version: "19" },
      { name: "WinRAR", version: "4" },
    ],
  });
  assert.equal(again.events, 0);
  const s = applySnapshot(db, {
    ...dev,
    items: [
      { name: "7-Zip", version: "23" },
      { name: "Google Chrome", version: "131" },
    ],
  });
  assert.equal(s.events, 3); // updated 7-Zip, installed Chrome, removed WinRAR
  const types = (db.prepare("SELECT type FROM install_event ORDER BY id").all() as { type: string }[])
    .map((r) => r.type)
    .sort();
  assert.deepEqual(types, ["installed", "removed", "updated"]);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM installation").get() as { c: number }).c, 2);
});

test("события агента меняют текущее состояние", () => {
  const db = seeded();
  applySnapshot(db, { ...dev, items: [{ name: "7-Zip", version: "19" }] });
  applyEvents(db, dev, [
    { type: "installed", name: "WinRAR 4.00 (64-bit)", new_version: "4.00" },
    { type: "updated", name: "7-Zip", old_version: "19", new_version: "23" },
  ]);
  const rows = db
    .prepare("SELECT raw_name, raw_version, catalog_id FROM installation ORDER BY raw_name")
    .all() as Row[];
  assert.deepEqual(
    rows.map((r) => [r.raw_name, r.raw_version, r.catalog_id]),
    [
      ["7-Zip", "23", 1],
      ["WinRAR 4.00 (64-bit)", "4.00", 2],
    ],
  );
  applyEvents(db, dev, [{ type: "removed", name: "7-Zip" }]);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM installation").get() as { c: number }).c, 1);
});

test("API: токен, ingest, compliance, запрещённое ПО", async () => {
  const db = seeded();
  db.exec("INSERT INTO license_purchase (catalog_id, seats, unit_price) VALUES (2, 0, 3000)");
  const app = await buildApp(db);
  const body = { ...dev, items: [{ name: "WinRAR 4.00 (64-bit)", version: "4.00" }] };

  assert.equal((await app.inject({ method: "POST", url: "/api/ingest/agent", payload: body })).statusCode, 401);
  const h = { "x-ingest-token": "dev-token" };
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/ingest/agent", headers: h, payload: { serial_number: "" } }))
      .statusCode,
    400,
  );
  const ok = await app.inject({ method: "POST", url: "/api/ingest/agent", headers: h, payload: body });
  assert.equal(ok.json().rows_matched, 1);

  const c = (await app.inject({ url: "/api/compliance" })).json();
  const winrar = c.rows.find((r: Row) => r.name === "WinRAR");
  assert.deepEqual([winrar.status, winrar.severity], ["forbidden", "red"]);
  const list = (await app.inject({ url: "/api/devices" })).json();
  assert.equal(list[0].forbidden_count, 1);
  assert.equal((await app.inject({ url: "/api/devices/SN1" })).json().software.length, 1);
  assert.equal((await app.inject({ url: "/api/devices/nope" })).statusCode, 404);
  await app.close();
});

test("повторный снимок сохраняет last_used, шум не попадает в события", () => {
  const db = seeded();
  applySnapshot(db, {
    ...dev,
    items: [{ name: "7-Zip", version: "19" }, { name: "Security Update for Microsoft Office (KB123456)" }],
  });
  db.exec("UPDATE installation SET last_used = '2026-01-01 00:00:00' WHERE raw_name = '7-Zip'");
  const s = applySnapshot(db, { ...dev, items: [{ name: "7-Zip", version: "19" }] }); // KB-обновление пропало
  assert.equal(s.events, 0);
  assert.equal(
    (db.prepare("SELECT last_used FROM installation WHERE raw_name = '7-Zip'").get() as { last_used: string })
      .last_used,
    "2026-01-01 00:00:00",
  );
});

test("события: ISO-время нормализуется, updated по неизвестной позиции создаёт её, шум без события", () => {
  const db = seeded();
  applyEvents(db, dev, [
    { type: "updated", name: "Google Chrome", old_version: "130", new_version: "131", at: "2026-11-14T09:00:00Z" },
    { type: "installed", name: "Microsoft Visual C++ 2015 Redistributable (x64)", new_version: "14.0" },
  ]);
  const ev = db.prepare("SELECT type, raw_name, at, catalog_id FROM install_event").all() as Row[];
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].type, ev[0].at, ev[0].catalog_id], ["updated", "2026-11-14 09:00:00", 3]);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM installation").get() as { c: number }).c, 2);
});

test("события от неизвестного ПК → 409 need_snapshot (агент пришлёт полный снимок)", async () => {
  const db = seeded();
  const app = await buildApp(db);
  const r = await app.inject({
    method: "POST",
    url: "/api/ingest/events",
    headers: { "x-ingest-token": "dev-token" },
    payload: { serial_number: "NEW", events: [{ type: "installed", name: "7-Zip" }] },
  });
  assert.deepEqual([r.statusCode, r.json().need_snapshot], [409, true]);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM install_event").get() as { c: number }).c, 0);
  await app.close();
});

test("ручной ввод установки: создаёт ПК, сопоставляет с каталогом, пишет событие; агентский токен не нужен", async () => {
  const db = openDb(":memory:");
  const cat = Number(db.prepare("INSERT INTO software_catalog (name) VALUES ('7-Zip')").run().lastInsertRowid);
  const app = await buildApp(db);
  const r = await app.inject({
    method: "POST",
    url: "/api/ingest/manual",
    payload: { serial_number: "MAN-1", hostname: "ws-man", name: "7-Zip 19.00 (x64)", version: "19.00" },
  });
  assert.equal(r.statusCode, 201);
  assert.deepEqual([r.json().catalog_id, r.json().is_noise], [cat, false]);
  assert.equal(
    (db.prepare("SELECT hostname FROM device WHERE serial_number = 'MAN-1'").get() as { hostname: string }).hostname,
    "ws-man",
  );
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) c FROM install_event WHERE device_serial = 'MAN-1' AND type = 'installed'").get() as {
        c: number;
      }
    ).c,
    1,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/ingest/manual", payload: { serial_number: "MAN-1" } })).statusCode,
    400,
  );
  await app.close();
});
