import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { config } from "../src/config.ts";
import { openDb } from "../src/db.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;

async function setup() {
  const db = openDb(":memory:");
  const app = await buildApp(db);
  const j = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const r = await app.inject({ method: method as "GET", url, payload: payload as object, headers });
    return { code: r.statusCode, body: r.body ? r.json() : null };
  };
  return { db, app, j };
}

test("ключ регистрации: показывается один раз, на сервере только хеш; лимит и отзыв", async () => {
  const { db, app, j } = await setup();
  const k = await j("POST", "/api/agent-enroll-keys", { title: "Установка 2026", max_uses: 2 });
  assert.equal(k.code, 201);
  assert.match(k.body.key, /^sek_/);
  assert.equal(
    JSON.stringify((await j("GET", "/api/agent-enroll-keys")).body).includes(k.body.key),
    false,
    "в списке ключа нет",
  );
  assert.equal(
    JSON.stringify(db.prepare("SELECT * FROM enroll_key").all()).includes(k.body.key),
    false,
    "в БД ключа нет",
  );

  const e = (serial: string, key = k.body.key) =>
    j("POST", "/api/agent/enroll", { enroll_key: key, serial_number: serial, hostname: "PC-" + serial });
  const a = await e("A");
  assert.equal(a.code, 200);
  assert.match(a.body.token, /^sat_/);
  assert.equal((await e("B")).code, 200);
  assert.match((await e("C")).body.error, /исчерпан \(2 из 2\)/);
  assert.equal((await e("D", "sek_неверный_ключ")).code, 403);
  assert.equal(
    (await j("GET", "/api/devices")).body.find((d: Row) => d.serial_number === "A").agent_status,
    "online",
    "регистрация = контакт",
  );

  const k2 = await j("POST", "/api/agent-enroll-keys", { title: "Отозванный" });
  assert.equal((await j("DELETE", `/api/agent-enroll-keys/${k2.body.id}`)).code, 204);
  assert.match((await e("E", k2.body.key)).body.error, /отозван/);
  await app.close();
});

test("токен ПК: только свой серийник; чужие задания недоступны; отзыв → 401 с reenroll", async () => {
  const { db, app, j } = await setup();
  const key = (await j("POST", "/api/agent-enroll-keys", { title: "k" })).body.key;
  const ta = (await j("POST", "/api/agent/enroll", { enroll_key: key, serial_number: "A" })).body.token;
  const tb = (await j("POST", "/api/agent/enroll", { enroll_key: key, serial_number: "B" })).body.token;
  const A = { "x-agent-token": ta };

  assert.equal((await j("POST", "/api/ingest/agent", { serial_number: "A", items: [{ name: "7-Zip" }] }, A)).code, 200);
  assert.equal(
    (await j("POST", "/api/ingest/agent", { serial_number: "B", items: [] }, A)).code,
    403,
    "за другой ПК — нельзя",
  );
  // задание с ключом лицензии для B: токен A его не получит
  db.exec(`INSERT INTO license_pool (product, title, license_key, key_tail, seats) VALUES ('cryptopro_csp', 'k', '11111-22222-33333-44444-55555', '55555', 5);
           INSERT INTO agent_command (device_serial, type, product, pool_id) VALUES ('B', 'set_license', 'cryptopro_csp', 1);`);
  assert.equal(
    (await j("GET", "/api/agent/commands?serial=B", undefined, A)).code,
    403,
    "чужие задания (с ключом лицензии) недоступны",
  );
  assert.equal((await j("GET", "/api/agent/commands?serial=B", undefined, { "x-agent-token": tb })).body.length, 1);

  // повторная регистрация ПК отзывает его прежний токен
  const ta2 = (await j("POST", "/api/agent/enroll", { enroll_key: key, serial_number: "A" })).body.token;
  const old = await j("POST", "/api/ingest/agent", { serial_number: "A", items: [] }, A);
  assert.deepEqual([old.code, old.body.reenroll], [401, true]);
  assert.equal(
    (await j("POST", "/api/ingest/agent", { serial_number: "A", items: [] }, { "x-agent-token": ta2 })).code,
    200,
  );

  const toks = (await j("GET", "/api/agent-tokens")).body;
  assert.equal(toks.filter((t: Row) => !t.revoked).length, 2);
  const active = toks.find((t: Row) => t.device_serial === "B" && !t.revoked);
  assert.equal((await j("DELETE", `/api/agent-tokens/${active.id}`)).code, 204);
  assert.equal((await j("GET", "/api/agent/commands?serial=B", undefined, { "x-agent-token": tb })).code, 401);
  await app.close();
});

test("REQUIRE_DEVICE_TOKEN: общий токен больше не принимается", async () => {
  const saved = config.requireDeviceToken;
  config.requireDeviceToken = true;
  try {
    const { app, j } = await setup();
    const r = await j(
      "POST",
      "/api/ingest/agent",
      { serial_number: "A", items: [] },
      { "x-ingest-token": "dev-token" },
    );
    assert.deepEqual([r.code, /токен ПК/.test(r.body.error)], [401, true]);
    await app.close();
  } finally {
    config.requireDeviceToken = saved;
  }
});

test("готовый sam-agent.json: новый ключ, без общего токена, ключ регистрирует агента", async () => {
  const { normalizeServerUrl } = await import("../src/services/agentAuth.ts");
  assert.equal(normalizeServerUrl("192.168.249.1:8000"), "http://192.168.249.1:8000");
  assert.equal(normalizeServerUrl("https://sam.corp.local/"), "https://sam.corp.local");
  for (const bad of ["ftp://x", "http://x/api", "http://u:p@x", "http://x?a=1", "не адрес"])
    assert.equal(normalizeServerUrl(bad), null, bad);

  const db = openDb(":memory:");
  const app = await buildApp(db);
  const r = await app.inject({
    method: "POST",
    url: "/api/agent-config",
    payload: { title: "Бухгалтерия", server: "192.168.249.1:8000/", max_uses: 2, days: 30 },
  });
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers["content-disposition"]), /sam-agent\.json/);
  const f = r.json();
  assert.equal(f.server, "http://192.168.249.1:8000");
  assert.match(f.enroll_key, /^sek_/);
  assert.equal(f.token, undefined, "общий INGEST_TOKEN в файл не кладём");
  assert.ok(!r.body.includes(config.ingestToken), "и нигде в тексте");
  assert.equal(f.interval, 60);
  // ключ виден в списке (маской) с ограничениями; открытым — нет
  const keys = (await app.inject({ url: "/api/agent-enroll-keys" })).json();
  assert.deepEqual(
    [keys[0].title, keys[0].max_uses, keys[0].key_masked],
    ["Бухгалтерия", 2, `sek_…${f.enroll_key.slice(-4)}`],
  );
  assert.ok(keys[0].expires_at > new Date().toISOString().slice(0, 10));
  // агент с этим файлом регистрируется
  const e = await app.inject({
    method: "POST",
    url: "/api/agent/enroll",
    payload: { enroll_key: f.enroll_key, serial_number: "PC-1" },
  });
  assert.equal(e.statusCode, 200);
  assert.match(e.json().token, /^sat_/);

  assert.equal(
    (await app.inject({ method: "POST", url: "/api/agent-config", payload: { title: "x", server: "http://x/api" } }))
      .statusCode,
    400,
  );
  const d = (await app.inject({ url: "/api/agent-config/defaults" })).json();
  assert.deepEqual(Object.keys(d).sort(), ["agent_exe", "public_url"]);
  await app.close();
});
