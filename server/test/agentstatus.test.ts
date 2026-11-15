import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { applyEvents, applySnapshot } from "../src/services/ingest.ts";
import { allocateUsed } from "../src/services/purchases.ts";
import { installMessagesSince } from "../src/services/stream.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;

const agent = { "x-ingest-token": "dev-token" };

test("статус агента: CSV-устройство — no_agent, после снимка агента — online, давно — offline/lost", async () => {
  const db = openDb(":memory:");
  applySnapshot(db, { serial_number: "CSV1", items: [{ name: "7-Zip" }], source: "csv" });
  db.exec("INSERT INTO employee (id, full_name, department) VALUES (1, 'Иванов', 'Бухгалтерия')");
  const app = await buildApp(db);
  await app.inject({
    method: "POST",
    url: "/api/ingest/agent",
    headers: agent,
    payload: { serial_number: "AG1", items: [] },
  });
  db.exec("UPDATE device SET employee_id = 1 WHERE serial_number = 'AG1'");
  const st = async () =>
    Object.fromEntries(
      (await app.inject({ url: "/api/devices" })).json().map((d: Row) => [d.serial_number, d.agent_status]),
    );
  assert.deepEqual(await st(), { CSV1: "no_agent", AG1: "online" });
  const d = (await app.inject({ url: "/api/devices" })).json().find((x: Row) => x.serial_number === "AG1");
  assert.deepEqual([d.department, d.employee], ["Бухгалтерия", "Иванов"]);
  db.exec("UPDATE device SET agent_last_seen = datetime('now', '-2 days') WHERE serial_number = 'AG1'");
  assert.equal((await st()).AG1, "offline");
  db.exec("UPDATE device SET agent_last_seen = datetime('now', '-10 days') WHERE serial_number = 'AG1'");
  assert.equal((await app.inject({ url: "/api/devices/AG1" })).json().device.agent_status, "lost");
  // опрос заданий — тоже сердцебиение
  await app.inject({ url: "/api/agent/commands?serial=AG1", headers: agent });
  assert.equal((await st()).AG1, "online");
  await app.close();
});

test("«Запросить снимок»: задание snapshot без ключа, повтор не дублирует, итог в журнале", async () => {
  const db = openDb(":memory:");
  const app = await buildApp(db);
  await app.inject({
    method: "POST",
    url: "/api/ingest/agent",
    headers: agent,
    payload: { serial_number: "AG1", items: [] },
  });
  const r1 = await app.inject({ method: "POST", url: "/api/devices/AG1/request-snapshot" });
  assert.deepEqual([r1.statusCode, r1.json().already_queued], [201, false]);
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/devices/AG1/request-snapshot" })).json().already_queued,
    true,
  );
  assert.equal((await app.inject({ method: "POST", url: "/api/devices/NOPE/request-snapshot" })).statusCode, 404);
  const cmds = (await app.inject({ url: "/api/agent/commands?serial=AG1", headers: agent })).json();
  assert.deepEqual(
    cmds.map((c: Row) => [c.type, c.key]),
    [["snapshot", null]],
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/agent/commands/${cmds[0].id}/result`,
        headers: agent,
        payload: { serial_number: "AG1", ok: true, output: "снимок отправлен" },
      })
    ).statusCode,
    200,
  );
  assert.equal((await app.inject({ url: "/api/agent-commands?status=done" })).json()[0].type, "snapshot");
  await app.close();
});

test("миграция: старая таблица заданий (CHECK только set_license) пересоздаётся с сохранением строк", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sam-mig-"));
  const file = path.join(dir, "old.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE device (serial_number TEXT PRIMARY KEY, hostname TEXT, os TEXT, employee_id INTEGER, last_seen TEXT);
    INSERT INTO device (serial_number) VALUES ('A');
    CREATE TABLE agent_command (id INTEGER PRIMARY KEY, device_serial TEXT NOT NULL REFERENCES device(serial_number),
      type TEXT NOT NULL CHECK (type IN ('set_license')), product TEXT NOT NULL, pool_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','done','failed','cancelled')), result TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO agent_command (device_serial, type, product) VALUES ('A', 'set_license', 'cryptopro_csp');`);
  old.close();
  const db = openDb(file);
  db.prepare("INSERT INTO agent_command (device_serial, type, product) VALUES ('A', 'snapshot', 'agent')").run();
  assert.deepEqual(
    (db.prepare("SELECT type FROM agent_command ORDER BY id").all() as { type: string }[]).map((r) => r.type),
    ["set_license", "snapshot"],
  );
  assert.ok(
    (db.prepare("PRAGMA table_info(device)").all() as { name: string }[]).some((c) => c.name === "agent_last_seen"),
    "колонка добавлена",
  );
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("места по договорам: сначала ближайший срок, бессрочный последним, превышение — на последний, просроченный 0", () => {
  const p = (
    id: number,
    seats: number,
    valid_until: string | null,
    status: "active" | "expiring" | "perpetual" | "expired",
  ) => ({ id, catalog_id: 1, seats, valid_until, status, installed: 115 });
  const r = allocateUsed([
    p(1, 70, null, "perpetual"),
    p(2, 18, "2027-06-30", "active"),
    p(3, 25, "2025-12-31", "expired"),
  ]);
  assert.deepEqual(
    r.map((x) => [x.id, x.used]),
    [
      [1, 97],
      [2, 18],
      [3, 0],
    ],
  );
  const ok = allocateUsed([{ ...p(1, 100, null, "perpetual"), installed: 60 }]);
  assert.equal(ok[0].used, 60);
});

test("алерт «превышение» только если установка заняла новое место на ПК", () => {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO software_catalog (id, name, license_kind) VALUES (1, 'Microsoft Office', 'commercial');
           INSERT INTO alias (norm_name, catalog_id) VALUES ('microsoft office standard 2016', 1), ('microsoft office professional plus 2016', 1);`);
  applySnapshot(db, { serial_number: "A", items: [{ name: "Microsoft Office Standard 2016" }] });
  applySnapshot(db, {
    serial_number: "A",
    items: [{ name: "Microsoft Office Standard 2016" }, { name: "Microsoft Office Professional Plus 2016" }],
  });
  const dup = installMessagesSince(db, 0);
  assert.deepEqual(
    dup.map((m) => [m.raw_name, m.alert]),
    [["Microsoft Office Professional Plus 2016", null]],
    "на ПК уже был Office — места не прибавилось",
  );
  applyEvents(db, { serial_number: "B" }, [{ type: "installed", name: "Microsoft Office Standard 2016" }]);
  const fresh = installMessagesSince(db, dup.at(-1)!.id);
  assert.equal(fresh[0].alert?.reason, "over_license", "новый ПК — новое место сверх 0 купленных");
});
