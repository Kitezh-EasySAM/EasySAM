import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { computeRisks, replaceDeviceLicenses, type LicenseRow } from "../src/services/licenses.ts";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const row = (o: Partial<LicenseRow>): LicenseRow => ({
  device_serial: "A",
  application: "windows",
  product: "Windows(R), Professional edition",
  channel: "Volume:MAK",
  partial_key: "AAAAA",
  status: "licensed",
  expires_at: null,
  ...o,
});

test("риски: не активировано, истекло, истекает, льготный период", () => {
  const rows = [
    row({ status: "notification" }),
    row({ device_serial: "B", expires_at: "2026-11-01 00:00:00" }),
    row({ device_serial: "C", expires_at: "2026-11-30 00:00:00" }),
    row({ device_serial: "D", expires_at: "2027-06-01 00:00:00" }),
    row({ device_serial: "E", status: "grace" }),
  ];
  const r = computeRisks(rows, NOW);
  assert.deepEqual(
    rows.map((x) => r.get(x)),
    [["unlicensed"], ["expired"], ["expiring"], [], ["grace"]],
  );
});

test("один ключ на нескольких ПК: только Retail/OEM; Volume (MAK/GVLK) одинаков по замыслу", () => {
  const rows = [
    row({ device_serial: "A", channel: "Retail", partial_key: "VK7JG" }),
    row({ device_serial: "B", channel: "Retail", partial_key: "VK7JG" }),
    row({ device_serial: "C", channel: "OEM:DM", partial_key: "Q1Q1Q" }),
    row({ device_serial: "D", channel: "Volume:GVLK", partial_key: "T83GX" }),
    row({ device_serial: "E", channel: "Volume:GVLK", partial_key: "T83GX" }),
    row({ device_serial: "A", channel: "Retail", partial_key: "VK7JG", application: "office" }), // другой продукт — не тот же ключ
  ];
  const r = computeRisks(rows, NOW);
  assert.deepEqual(
    rows.map((x) => r.get(x)),
    [["key_reuse"], ["key_reuse"], [], [], [], []],
  );
});

test("ключ антивируса (KES, Dr.Web) на многих ПК — норма; тревога только сверх мест из хранилища", () => {
  const kes = (dev: string) =>
    row({
      device_serial: dev,
      application: "kaspersky_kes",
      product: "Kaspersky Endpoint Security 12.6",
      channel: "Коммерческая",
      partial_key: "AB78C",
    });
  const rows = ["A", "B", "C"].map(kes);
  assert.deepEqual(
    rows.map((x) => computeRisks(rows, NOW).get(x)),
    [[], [], []],
    "без записи в хранилище — не переиспользование",
  );
  const two = new Map([["kaspersky_kes|AB78C", 2]]);
  assert.deepEqual(
    rows.map((x) => computeRisks(rows, NOW, two).get(x)),
    [["key_reuse"], ["key_reuse"], ["key_reuse"]],
    "3 ПК при 2 местах",
  );
  // nanoCAD/1С — файл лицензии привязан к ПК: тот же номер на 2 ПК — тревога (как у КриптоПро)
  const nano = ["A", "B"].map((d) =>
    row({
      device_serial: d,
      application: "nanocad",
      product: "nanoCAD Plus",
      channel: "Локальная",
      partial_key: "8KQ2T",
    }),
  );
  assert.deepEqual(
    nano.map((x) => computeRisks(nano, NOW).get(x)),
    [["key_reuse"], ["key_reuse"]],
  );
  // «unknown» (KES 11 без LICENSE /CHECK) — не риск, просто нет данных
  assert.deepEqual(
    computeRisks([row({ application: "kaspersky_kes", status: "unknown", partial_key: null })], NOW)
      .values()
      .next().value,
    [],
  );
});

function setup() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO device (serial_number, hostname) VALUES ('A', 'WS-A'), ('B', 'WS-B');
           INSERT INTO employee (id, full_name) VALUES (1, 'Иванов Иван'); UPDATE device SET employee_id = 1 WHERE serial_number = 'B';`);
  return db;
}

test("алерты только по НОВЫМ рискам: повторный снимок не спамит", () => {
  const db = setup();
  const retail = {
    application: "windows",
    product: "Windows(R), Professional edition",
    channel: "Retail",
    partial_key: "VK7JG",
    status: "licensed",
  };
  assert.deepEqual(replaceDeviceLicenses(db, "A", [retail]), []);
  const a = replaceDeviceLicenses(db, "B", [retail]); // тот же Retail-ключ на втором ПК
  assert.deepEqual(
    a.map((x) => [x.risk, x.level]),
    [["key_reuse", "red"]],
  );
  assert.match(a[0].text, /Один Retail-ключ …VK7JG на 2 ПК.*WS-B \(Иванов Иван\)/);
  assert.deepEqual(replaceDeviceLicenses(db, "B", [retail]), [], "повтор того же снимка");
  const b = replaceDeviceLicenses(db, "B", [{ ...retail, status: "notification" }]);
  assert.deepEqual(
    b.map((x) => x.risk),
    ["unlicensed"],
  );
  assert.match(b[0].text, /Windows «Windows\(R\), Professional edition» не активирована на WS-B/);
  assert.deepEqual(replaceDeviceLicenses(db, "B", []).length, 0);
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM device_license WHERE device_serial = 'B'").get() as { c: number }).c,
    0,
  );
});

test("API: снимок агента с лицензиями → /api/license-keys, карточка ПК, SSE-готовые алерты; полный ключ отвергается", async () => {
  const db = openDb(":memory:");
  const app = await buildApp(db);
  const h = { "x-ingest-token": "dev-token" };
  const lic = {
    application: "windows",
    product: "Windows(R), Professional edition",
    channel: "Volume:GVLK",
    partial_key: "T83GX",
    status: "licensed",
    status_code: 1,
    expires_at: new Date(Date.now() + 6 * 86_400_000).toISOString().slice(0, 19).replace("T", " "),
  }; // через 6 дней
  const send = (body: object) =>
    app.inject({
      method: "POST",
      url: "/api/ingest/agent",
      headers: h,
      payload: { serial_number: "VM1", hostname: "WIN-VM", items: [], ...body },
    });

  const r = await send({ licenses: [lic] });
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().licenses, r.json().license_alerts], [1, 1]); // истекает < 30 дней

  const keys = (await app.inject({ url: "/api/license-keys" })).json();
  assert.deepEqual([keys.summary.total, keys.summary.expiring], [1, 1]);
  assert.deepEqual(
    [keys.items[0].hostname, keys.items[0].severity, keys.items[0].risks],
    ["WIN-VM", "yellow", ["expiring"]],
  );
  assert.equal((await app.inject({ url: "/api/license-keys?risk=key_reuse" })).json().items.length, 0);
  assert.equal((await app.inject({ url: "/api/devices/VM1" })).json().licenses.length, 1);

  assert.equal((await send({})).json().licenses, null); // агент без лицензий в снимке — старые не трогаем
  assert.equal((await app.inject({ url: "/api/license-keys" })).json().summary.total, 1);

  assert.equal((await send({ licenses: [{ ...lic, partial_key: "XXXXX-XXXXX-XXXXX-XXXXX-T83GX" }] })).statusCode, 400);
  await app.close();
});
