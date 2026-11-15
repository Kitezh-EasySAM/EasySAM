import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { hasMaterials } from "../src/scripts/materials.ts";
import { seed, seedBase, seedDemo } from "../src/scripts/seed.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;

test("seed: демо-сценарии на реальных данных", { skip: !hasMaterials(), timeout: 120_000 }, async () => {
  const db = openDb(":memory:");
  const st = await seed(db);
  assert.equal(st.devices, 187);
  await assert.rejects(() => seed(db), /не пустая/); // защита от повторного запуска

  const app = await buildApp(db);
  const { rows, summary } = (await app.inject({ url: "/api/compliance" })).json();
  const by = (n: string) => rows.find((r: Row) => r.name === n);
  assert.equal(by("Microsoft Office").status, "over");
  assert.ok(by("Microsoft Office").penalty > 0);
  assert.equal(by("WinRAR").status, "forbidden");
  assert.equal(by("Adobe Photoshop").status, "over");
  assert.equal(by("Adobe Photoshop").seats, 0);
  assert.equal(by("DIRECTUM").status, "ok");
  assert.ok(summary.red >= 5);
  assert.ok(summary.total_penalty > 0);
  // источник правды о покупках: просроченная закупка Office не считается
  assert.equal(
    by("Microsoft Office").seats,
    db
      .prepare(
        "SELECT SUM(seats) s FROM license_purchase p JOIN software_catalog c ON c.id=p.catalog_id WHERE c.name='Microsoft Office' AND (valid_until IS NULL OR valid_until >= date('now'))",
      )
      .get()?.s,
  );
  await app.close();
});

test(
  "seed: реальные данные без демо, демо — отдельным шагом",
  { skip: !hasMaterials(), timeout: 120_000 },
  async () => {
    const db = openDb(":memory:");
    assert.throws(() => seedDemo(db), /нет реальных данных/);
    const st = await seedBase(db);
    assert.equal(st.devices, 187);
    const n = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
    // ничего демо: ни людей, ни закупок, ни цен, ни лицензий ПК, ни ключей, ни КриптоПро, ни ОС, ни «последнего запуска»
    for (const t of ["employee", "license_purchase", "device_license", "license_pool"])
      assert.equal(n(`SELECT COUNT(*) c FROM ${t}`), 0, t);
    assert.equal(
      n(
        "SELECT COUNT(*) c FROM software_catalog WHERE name = 'КриптоПро CSP' OR internal_status != 'current' OR list_price IS NOT NULL OR min_version IS NOT NULL",
      ),
      0,
    );
    assert.equal(n("SELECT COUNT(*) c FROM device WHERE os IS NOT NULL OR employee_id IS NOT NULL"), 0);
    assert.equal(n("SELECT COUNT(*) c FROM installation WHERE last_used IS NOT NULL"), 0);
    assert.ok(
      n("SELECT COUNT(*) c FROM installation WHERE catalog_id IS NOT NULL") > 1000,
      "распознавание работает и без демо",
    );

    const d = seedDemo(db);
    assert.deepEqual([d.devices, d.employees, d.purchases], [187, 177, 9]);
    assert.throws(() => seedDemo(db), /уже есть/);
    assert.equal(
      n("SELECT COUNT(*) c FROM software_catalog WHERE name = 'WinRAR' AND internal_status = 'forbidden'"),
      1,
    );
  },
);
