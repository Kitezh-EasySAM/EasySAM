import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { applySnapshot } from "../src/services/ingest.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;

async function setup() {
  const db = openDb(":memory:");
  applySnapshot(db, {
    serial_number: "SN1",
    items: [{ name: "Adobe Photoshop CS4 (64 Bit)", version: "11.0" }, { name: "Mystery" }],
  });
  const app = await buildApp(db);
  const j = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: payload as object });
    return { code: r.statusCode, body: r.body ? r.json() : null };
  };
  return { db, app, j };
}

test("каталог: создание подхватывает нераспознанные установки, поиск по кириллице, карточка «у кого стоит»", async () => {
  const { app, j } = await setup();
  const lt = await j("POST", "/api/license-types", { name: "Adobe EULA", kind: "commercial" });
  assert.equal(lt.code, 201);
  assert.equal(lt.body.commercial_use, null);

  const c = await j("POST", "/api/catalog", {
    name: "Adobe Photoshop CS4",
    license_kind: "commercial",
    license_type_id: lt.body.id,
    internal_status: "outdated",
    list_price: 35000,
    in_ru_registry: false,
  });
  assert.equal(c.code, 201);
  assert.equal(c.body.installed, 1, "rematch должен привязать установку по точному имени");
  assert.equal(c.body.in_ru_registry, false);
  assert.equal(c.body.license_type_name, "Adobe EULA");

  await j("POST", "/api/catalog", { name: "Консультант Плюс" });
  assert.equal((await j("GET", "/api/catalog?q=консультант")).body.total, 1);
  assert.equal((await j("GET", "/api/catalog?q=КОНСУЛЬТАНТ")).body.total, 1);
  assert.equal((await j("GET", "/api/catalog?status=outdated")).body.items[0].name, "Adobe Photoshop CS4");

  const card = await j("GET", `/api/catalog/${c.body.id}`);
  assert.deepEqual(
    card.body.devices.map((d: Row) => d.device_serial),
    ["SN1"],
  );

  assert.equal((await j("POST", "/api/catalog", { name: "Adobe Photoshop CS4" })).code, 409); // дубль
  assert.equal((await j("POST", "/api/catalog", { name: "X", hack: 1 })).code, 400); // лишнее поле
  assert.equal((await j("POST", "/api/catalog", { name: "X", license_kind: "pirate" })).code, 400);
  assert.equal(
    (await j("PATCH", `/api/catalog/${c.body.id}`, { internal_status: "forbidden" })).body.internal_status,
    "forbidden",
  );
  assert.equal((await j("PATCH", "/api/catalog/9999", { vendor: "x" })).code, 404);
  assert.equal((await j("DELETE", `/api/catalog/${c.body.id}`)).code, 409); // есть установки
  assert.equal((await j("DELETE", `/api/license-types/${lt.body.id}`)).code, 409); // используется
  await app.close();
});

test("закупки: влияют на compliance, просроченные не считаются", async () => {
  const { app, j } = await setup();
  const c = (
    await j("POST", "/api/catalog", { name: "Adobe Photoshop CS4", license_kind: "commercial", list_price: 35000 })
  ).body;
  let row = (await j("GET", "/api/compliance")).body.rows[0];
  assert.deepEqual([row.status, row.penalty], ["over", 35000]);

  const p = await j("POST", "/api/purchases", {
    catalog_id: c.id,
    seats: 1,
    unit_price: 30000,
    valid_until: "2099-12-31",
  });
  assert.equal(p.code, 201);
  assert.equal(p.body.active, true);
  row = (await j("GET", "/api/compliance")).body.rows[0];
  assert.deepEqual([row.status, row.seats], ["ok", 1]);

  assert.equal((await j("PATCH", `/api/purchases/${p.body.id}`, { valid_until: "2020-01-01" })).body.active, false);
  assert.equal((await j("GET", "/api/compliance")).body.rows[0].status, "over");

  assert.equal((await j("POST", "/api/purchases", { catalog_id: 999, seats: 1 })).code, 400);
  assert.equal(
    (await j("POST", "/api/purchases", { catalog_id: c.id, seats: 1, valid_until: "31.12.2027" })).code,
    400,
  );
  assert.equal((await j("GET", `/api/purchases?catalog_id=${c.id}`)).body.length, 1);
  assert.equal((await j("DELETE", `/api/purchases/${p.body.id}`)).code, 204);
  assert.equal((await j("DELETE", `/api/purchases/${p.body.id}`)).code, 404);
  await app.close();
});

test("сотрудники и привязка ПК; уволенный владелец = зомби-установка", async () => {
  const { app, j } = await setup();
  await j("POST", "/api/catalog", { name: "Adobe Photoshop CS4", license_kind: "commercial", list_price: 100 });
  const e = await j("POST", "/api/employees", { full_name: "Петрова Анна", department: "Дизайн" });
  assert.deepEqual([e.code, e.body.active, e.body.devices], [201, true, []]);

  assert.equal(
    (await j("PATCH", "/api/devices/SN1", { employee_id: e.body.id, hostname: "DESIGN-01" })).body.employee_id,
    e.body.id,
  );
  assert.equal((await j("PATCH", "/api/devices/SN1", { employee_id: 999 })).code, 400);
  assert.equal((await j("PATCH", "/api/devices/NOPE", { hostname: "x" })).code, 404);
  assert.deepEqual((await j("GET", `/api/employees?q=петрова`)).body[0].devices, ["SN1"]);

  assert.equal((await j("GET", "/api/compliance")).body.summary.zombie, 0);
  await j("PATCH", `/api/employees/${e.body.id}`, { active: false });
  const s = (await j("GET", "/api/compliance")).body.summary;
  assert.deepEqual([s.zombie, s.total_reclaimable], [1, 100]);
  assert.equal((await j("GET", "/api/employees?active=false")).body.length, 1);

  assert.equal((await j("DELETE", `/api/employees/${e.body.id}`)).code, 204);
  assert.equal((await j("GET", "/api/devices/SN1")).body.device.employee_id, null);
  await app.close();
});
