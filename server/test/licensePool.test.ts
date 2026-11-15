import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { createEnrollKey, enroll } from "../src/services/agentAuth.ts";
import { openDb } from "../src/db.ts";
import { keyTail, maskKey } from "../src/services/licensePool.ts";
import { computeRisks, type LicenseRow } from "../src/services/licenses.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;

const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

test("маска и хвост ключа", () => {
  assert.equal(maskKey("40501-A0000-02ABC-DEF12-7KX2M"), "•••••-•••••-•••••-•••••-7KX2M");
  assert.equal(keyTail("40501-a0000-02abc-def12-7kx2m"), "7KX2M");
});

test("риски стороннего ПО: места из хранилища, ключ без покупки, пробная", () => {
  const r = (serial: string, key: string | null, status = "licensed"): LicenseRow => ({
    device_serial: serial,
    application: "cryptopro_csp",
    product: "КриптоПро CSP",
    channel: "Клиентская",
    partial_key: key,
    status,
    expires_at: null,
  });
  const rows = [r("A", "7KX2M"), r("B", "7KX2M"), r("C", "Q7W2E"), r("D", "Q7W2E"), r("E", null, "trial")];
  const risks = computeRisks(rows, Date.now(), new Map([["cryptopro_csp|7KX2M", 50]]));
  assert.deepEqual(
    rows.map((x) => risks.get(x)),
    [[], [], ["key_reuse"], ["key_reuse"], ["trial"]],
  );
  const tight = computeRisks(rows, Date.now(), new Map([["cryptopro_csp|7KX2M", 1]]));
  assert.deepEqual(tight.get(rows[0]), ["key_reuse"], "2 ПК при 1 купленном месте");
});

async function setup() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO device (serial_number, hostname) VALUES ('A','WS-A'),('B','WS-B'),('C','WS-C'),('D','WS-D');
    INSERT INTO installation (device_serial, raw_name, norm_name) VALUES ('D', 'КриптоПро CSP', 'криптопро csp');`);
  const lic =
    db.prepare(`INSERT INTO device_license (device_serial, application, product, channel, partial_key, status, expires_at)
    VALUES (?, 'cryptopro_csp', 'КриптоПро CSP 5.0', 'Клиентская, годовая', ?, ?, ?)`);
  lic.run("A", "9PL4T", "licensed", day(5)); // истекает
  lic.run("B", "9PL4T", "licensed", day(5)); // истекает
  lic.run("C", null, "trial", day(60)); // пробная (не «истекает»: > 30 дней)
  const app = await buildApp(db);
  const j = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method: method as "GET", url, payload: payload as object, headers });
    return { code: r.statusCode, body: r.body ? r.json() : null };
  };
  return { db, app, j };
}
const agent = { "x-ingest-token": "dev-token" };

test("хранилище: ключ наружу только маской; раздача по подборке; места; канал агента; итог", async () => {
  const { db, app, j } = await setup();
  const add = await j("POST", "/api/license-pool", {
    product: "cryptopro_csp",
    title: "Продление",
    license_key: "50501-C0000-04RTY-UIO56-3MN8R",
    seats: 2,
    valid_until: "2099-12-31",
  });
  assert.equal(add.code, 201);
  assert.equal(add.body.key_masked, "•••••-•••••-•••••-•••••-3MN8R");
  assert.equal(JSON.stringify(add.body).includes("04RTY"), false, "полный ключ не утекает в API");
  assert.equal(JSON.stringify((await j("GET", "/api/license-pool")).body).includes("04RTY"), false);
  assert.equal(
    (await j("POST", "/api/license-pool", { product: "kaspersky", title: "x", license_key: "AAAAA-BBBBB" })).code,
    400,
    "только известные продукты",
  );

  const over = await j("POST", `/api/license-pool/${add.body.id}/deploy`, { devices: ["A", "B", "C"] });
  assert.deepEqual([over.code, /не хватает мест: нужно 3, свободно 2/.test(over.body.error)], [409, true]);
  const dep = await j("POST", `/api/license-pool/${add.body.id}/deploy`, { filter: "expiring" });
  assert.deepEqual([dep.code, dep.body.queued], [200, 2]);
  assert.equal(
    (await j("POST", `/api/license-pool/${add.body.id}/deploy`, { filter: "expiring" })).body.skipped_already,
    2,
    "повтор не дублирует",
  );
  assert.equal((await j("GET", "/api/license-pool")).body[0].free, 0, "места заняты командами в пути");

  assert.equal((await j("GET", "/api/agent/commands?serial=A")).code, 401, "канал агента — только с токеном");
  assert.deepEqual(
    (await j("GET", "/api/agent/commands?serial=A", undefined, agent)).body,
    [],
    "по общему токену ключи не выдаются",
  );
  const own = {
    "x-agent-token": enroll(db, { enroll_key: createEnrollKey(db, { title: "тест" }).key, serial_number: "A" }).token,
  };
  const cmds = (await j("GET", "/api/agent/commands?serial=A", undefined, own)).body;
  assert.deepEqual(
    cmds.map((c: Row) => [c.type, c.product, c.key]),
    [["set_license", "cryptopro_csp", "50501-C0000-04RTY-UIO56-3MN8R"]],
  );
  assert.equal((await j("GET", "/api/agent-commands?status=sent")).body.length, 1);

  assert.equal(
    (await j("POST", `/api/agent/commands/${cmds[0].id}/result`, { serial_number: "B", ok: true }, agent)).code,
    404,
    "чужой ПК не может закрыть команду",
  );
  assert.equal(
    (
      await j(
        "POST",
        `/api/agent/commands/${cmds[0].id}/result`,
        { serial_number: "A", ok: true, output: "OK\nСерийный номер: 50501-C0000-04RTY-UIO56-3MN8R" },
        agent,
      )
    ).code,
    200,
  );
  const stored = JSON.stringify((await j("GET", "/api/agent-commands?status=done")).body);
  assert.ok(
    !stored.includes("04RTY") && stored.includes("•••••-•••••-•••••-•••••-3MN8R"),
    "полный ключ из вывода cpconfig не сохраняется",
  );
  assert.equal((await j("GET", "/api/agent-commands?status=done")).body[0].hostname, "WS-A");
  assert.equal(
    (await j("POST", `/api/agent/commands/${cmds[0].id}/result`, { serial_number: "A", ok: true }, agent)).code,
    404,
    "повторно не закрывается",
  );
  await app.close();
});

test("подборка «without»: ПК, где продукт установлен, а лицензии нет; обзор по продуктам", async () => {
  const { app, j } = await setup();
  const add = (
    await j("POST", "/api/license-pool", {
      product: "cryptopro_csp",
      title: "K",
      license_key: "11111-22222-33333-44444-55555",
      seats: 10,
    })
  ).body;
  assert.deepEqual((await j("POST", `/api/license-pool/${add.id}/deploy`, { filter: "without" })).body.queued, 1);
  assert.equal((await j("POST", `/api/license-pool/${add.id}/deploy`, { devices: ["NOPE"] })).code, 409);
  assert.equal((await j("POST", `/api/license-pool/${add.id}/deploy`, { devices: ["A"], filter: "trial" })).code, 400);

  const ov = (await j("GET", "/api/license-products")).body.find((p: Row) => p.application === "cryptopro_csp");
  assert.deepEqual([ov.title, ov.devices, ov.expiring, ov.trial, ov.can_deploy], ["КриптоПро CSP", 3, 2, 1, true]);
  assert.equal(ov.pool[0].pending, 1);
  assert.equal((await j("DELETE", `/api/license-pool/${add.id}`)).code, 204);
  assert.equal(
    (await j("GET", "/api/agent-commands?status=cancelled")).body.length,
    1,
    "удаление ключа отменяет команды в пути",
  );
  await app.close();
});

test("ключи лицензий любых продуктов: учёт мест KES по ID лицензии, раздача — только где агент умеет", async () => {
  const db = openDb(":memory:");
  const app = await buildApp(db);
  const j = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: payload as object });
    return { code: r.statusCode, body: r.body ? r.json() : null };
  };
  const products = (await j("GET", "/api/license-pool/products")).body as {
    product: string;
    can_deploy: boolean;
    key_hint: string;
  }[];
  assert.deepEqual(
    products.filter((p) => p.can_deploy).map((p) => p.product),
    ["cryptopro_csp"],
  );
  assert.ok(products.some((p) => p.product === "kaspersky_kes" && p.key_hint.includes("ID лицензии")));

  db.exec(`INSERT INTO device (serial_number, hostname) VALUES ('A','WS-A'), ('B','WS-B'), ('C','WS-C');`);
  for (const s of ["A", "B", "C"])
    db.prepare(
      "INSERT INTO device_license (device_serial, application, product, channel, partial_key, status) VALUES (?, 'kaspersky_kes', 'KES 12', 'Коммерческая', 'AB78C', 'licensed')",
    ).run(s);
  const kes = await j("POST", "/api/license-pool", {
    product: "kaspersky_kes",
    title: "KES, договор 1",
    license_key: "3084-000789-456AB78C",
    seats: 2,
  });
  assert.equal(kes.code, 201);
  assert.deepEqual(
    [kes.body.key_masked.endsWith("AB78C"), kes.body.used, kes.body.free],
    [true, 3, 0],
    "занятые места — по ID лицензии с ПК",
  );
  // 3 ПК при 2 местах → key_reuse; без записи в хранилище KES не тревожил бы
  const risky = (await j("GET", "/api/license-keys?risk=key_reuse")).body.items.filter(
    (x: { application: string }) => x.application === "kaspersky_kes",
  );
  assert.equal(risky.length, 3);
  // раздать нельзя: агент не умеет ставить ключи KES
  const dep = await j("POST", `/api/license-pool/${kes.body.id}/deploy`, { filter: "without" });
  assert.equal(dep.code, 409);
  assert.match(dep.body.error, /только для учёта/);
  assert.equal(
    (await j("POST", "/api/license-pool", { product: "photoshop", title: "x", license_key: "AAAAA-BBBBB" })).code,
    400,
  );
  const over = (await j("GET", "/api/license-products")).body.find(
    (p: { application: string }) => p.application === "kaspersky_kes",
  );
  assert.deepEqual([over.can_deploy, over.pool.length], [false, 1]);
  await app.close();
});
