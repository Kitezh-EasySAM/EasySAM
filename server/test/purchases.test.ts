import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { purchaseStatus } from "../src/services/purchases.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;

const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

test("статус закупки по сроку", () => {
  const today = "2026-11-14";
  assert.deepEqual(purchaseStatus(null, today), { status: "perpetual", days_left: null });
  assert.deepEqual(
    purchaseStatus("2026-11-14", today),
    { status: "expiring", days_left: 0 },
    "последний день — ещё действует",
  );
  assert.deepEqual(purchaseStatus("2026-12-14", today), { status: "expiring", days_left: 30 });
  assert.deepEqual(purchaseStatus("2026-12-15", today), { status: "active", days_left: 31 });
  assert.deepEqual(purchaseStatus("2026-11-13", today), { status: "expired", days_left: -1 });
});

test("API закупок: стоимость, статус, фильтр, сводка «что истекает и сколько стоит продлить»", async () => {
  const db = openDb(":memory:");
  db.exec(
    `INSERT INTO software_catalog (id, name, license_kind) VALUES (1, 'КриптоПро CSP', 'commercial'), (2, 'Microsoft Office', 'commercial')`,
  );
  const ins = db.prepare(
    "INSERT INTO license_purchase (catalog_id, seats, unit_price, valid_until, contract) VALUES (?, ?, ?, ?, ?)",
  );
  ins.run(1, 50, 2700, null, "бессрочная");
  ins.run(1, 30, 2700, day(12), "годовая");
  ins.run(2, 25, 15000, day(-20), "истекла");
  ins.run(2, 100, 15000, day(200), "действует");
  const app = await buildApp(db);
  const list = (await app.inject({ url: "/api/purchases" })).json();
  const by = (c: string) => list.find((p: Row) => p.contract === c);
  assert.deepEqual(
    [by("годовая").status, by("годовая").days_left, by("годовая").total_cost, by("годовая").active],
    ["expiring", 12, 81000, true],
  );
  assert.deepEqual([by("бессрочная").status, by("бессрочная").total_cost], ["perpetual", 135000]);
  assert.deepEqual([by("истекла").status, by("истекла").active], ["expired", false]);
  assert.equal((await app.inject({ url: "/api/purchases?status=expiring" })).json().length, 1);

  const s = (await app.inject({ url: "/api/purchases/summary" })).json();
  assert.deepEqual(s.by_status.expiring, { purchases: 1, seats: 30, cost: 81000 });
  assert.equal(s.renewal_cost, 81000);
  assert.equal(s.active_cost, 135000 + 81000 + 1_500_000);
  assert.deepEqual([s.total.purchases, s.total.seats], [4, 205]);
  assert.deepEqual([s.expiring[0].catalog_name, s.expiring[0].days_left], ["КриптоПро CSP", 12]);
  assert.equal(s.next_expiry, day(12));
  await app.close();
});
