import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { levenshtein, similarity, suggest, type Candidate } from "../src/services/fuzzy.ts";
import { applySnapshot } from "../src/services/ingest.ts";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { config } from "../src/config.ts";
import { aiSuggest } from "../src/services/aiMatch.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;

test("fuzzy: Левенштейн и похожесть", () => {
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(similarity("google chrome", "google chrome"), 1);
  assert.ok(similarity("gogle chrome", "google chrome") > 0.9, "опечатка");
  assert.ok(similarity("chrome google", "google chrome") === 1, "перестановка слов");
  assert.ok(similarity("directum rapid waiter", "directum") >= 0.8, "вложенность");
  assert.ok(similarity("microsoft silverlight", "7-zip") < 0.3, "непохожее ниже порога подсказок");
  // транслитерация (реальная ВМ: «CryptoPro CSP» против каталожного «КриптоПро CSP»)
  assert.equal(similarity("cryptopro csp", "криптопро csp"), 1);
  assert.ok(similarity("директум", "directum") >= 0.9, "DIRECTUM по-русски");
  assert.ok(similarity("гугл хром", "microsoft visio") < 0.5, "транслит не создаёт ложных совпадений");
});

test("fuzzy: подсказки схлопывают дубли каталога и учитывают издателя", () => {
  const c: Candidate[] = [
    { catalogId: 1, catalogName: "Google Chrome", norm: "google chrome", vendor: "google" },
    { catalogId: 1, catalogName: "Google Chrome", norm: "chrome", vendor: "google" },
    { catalogId: 2, catalogName: "Chromium", norm: "chromium", vendor: "" },
  ];
  const s = suggest("google chrome beta", "Google LLC", c);
  assert.equal(s[0].catalog_id, 1);
  assert.equal(s.filter((x) => x.catalog_id === 1).length, 1);
  assert.deepEqual(suggest("совсем другое", null, c), []);
  // общее слово-вендор не должно давать подсказку (регрессия на «Microsoft Silverlight» → Visio)
  const ms: Candidate[] = [
    { catalogId: 3, catalogName: "Microsoft Visio", norm: "microsoft visio", vendor: "microsoft" },
  ];
  assert.deepEqual(suggest("microsoft silverlight", "Microsoft Corporation", ms), []);
});

async function setup() {
  const db = openDb(":memory:");
  db.exec("INSERT INTO software_catalog (id, name, license_kind) VALUES (1, 'DIRECTUM', 'commercial')");
  applySnapshot(db, {
    serial_number: "A",
    items: [{ name: "DIRECTUM RapID Waiter 5.5.1" }, { name: "Microsoft Silverlight" }, { name: "DIRECTUM" }],
  });
  applySnapshot(db, {
    serial_number: "B",
    items: [{ name: "DIRECTUM RapID Waiter 5.5.1" }, { name: "Microsoft Silverlight" }],
  });
  const app = await buildApp(db);
  const j = async (method: string, url: string, payload?: unknown) => {
    const r = await app.inject({ method: method as "GET", url, payload: payload as object });
    return { code: r.statusCode, body: r.json() };
  };
  return { db, app, j };
}

test("неопознанное: группы, подсказки, привязка запоминается для будущих загрузок", async () => {
  const { db, app, j } = await setup();
  const list = (await j("GET", "/api/unmatched")).body;
  assert.deepEqual([list.total, list.total_installations, list.total_devices], [2, 4, 2]);
  const waiter = list.items.find((g: Row) => g.norm_name === "directum rapid waiter");
  assert.equal(waiter.devices, 2);
  assert.equal(waiter.suggestions[0].catalog_id, 1);
  assert.equal((await j("GET", "/api/unmatched?q=silver")).body.total, 1);

  const r = await j("POST", "/api/unmatched/resolve", { norm_names: ["directum rapid waiter"], catalog_id: 1 });
  assert.deepEqual([r.code, r.body.updated_installations], [200, 2]);
  assert.equal((await j("GET", "/api/unmatched")).body.total, 1);

  // новая загрузка: имя уже распознаётся через alias
  applySnapshot(db, { serial_number: "C", items: [{ name: "DIRECTUM RapID Waiter 5.5.1" }] });
  const row = db.prepare("SELECT catalog_id, match_method FROM installation WHERE device_serial = 'C'").get() as Row;
  assert.deepEqual([row.catalog_id, row.match_method], [1, "alias"]);
  await app.close();
});

test("неопознанное: игнор превращает в шум сейчас и при будущих загрузках; ошибки валидации", async () => {
  const { db, app, j } = await setup();
  assert.equal(
    (await j("POST", "/api/unmatched/resolve", { norm_names: ["microsoft silverlight"], ignore: true })).body
      .updated_installations,
    2,
  );
  assert.equal((await j("GET", "/api/unmatched?q=silver")).body.total, 0);
  const s = applySnapshot(db, { serial_number: "C", items: [{ name: "Microsoft Silverlight" }] });
  assert.equal(s.rowsNoise, 1);

  assert.equal((await j("POST", "/api/unmatched/resolve", { norm_names: ["x"], catalog_id: 999 })).code, 400);
  assert.equal((await j("POST", "/api/unmatched/resolve", { norm_names: [], ignore: true })).code, 400);
  assert.equal((await j("POST", "/api/unmatched/resolve", { norm_names: ["x"] })).code, 400);
  assert.equal(
    (await j("POST", "/api/unmatched/resolve", { norm_names: ["x"], ignore: true, catalog_id: 1 })).code,
    400,
  );
  await app.close();
});

test("ИИ-подсказки: позиция каталога, компонент, выдуманный id отбрасывается; в модель уходят только названия", async () => {
  const db = openDb(":memory:");
  const chrome = Number(
    db.prepare("INSERT INTO software_catalog (name, vendor) VALUES ('Google Chrome', 'Google')").run().lastInsertRowid,
  );
  db.prepare("INSERT INTO employee (full_name) VALUES ('Секретов Пётр')").run();
  applySnapshot(db, {
    serial_number: "PC-1",
    hostname: "ws-secret",
    source: "csv",
    items: [{ name: "Хром браузер", publisher: "Google LLC" }, { name: "Foo Helper Plugin" }, { name: "Mystery Tool" }],
  });
  const norms = (
    db.prepare("SELECT norm_name FROM installation WHERE catalog_id IS NULL AND is_noise = 0 ORDER BY id").all() as {
      norm_name: string;
    }[]
  ).map((r) => r.norm_name);
  assert.equal(norms.length, 3);
  let sent = "";
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      sent = b;
      const content = JSON.stringify({
        items: [
          { n: 1, verdict: "catalog", catalog_id: chrome, why: "русское название Chrome" },
          { n: 2, verdict: "component", catalog_id: null, why: "плагин" },
          { n: 3, verdict: "catalog", catalog_id: 9999, why: "выдумка" },
        ],
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const saved = config.openaiBaseUrl;
  config.openaiBaseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const r = await aiSuggest(db, norms);
    assert.deepEqual(
      r.map((x) => [x.verdict, x.catalog_id]),
      [
        ["catalog", chrome],
        ["component", null],
        ["unknown", null],
      ],
    );
    assert.equal(r[0].name, "Google Chrome");
    assert.ok(sent.includes("Хром браузер") && sent.includes("Google Chrome"));
    assert.ok(
      !sent.includes("Секретов") && !sent.includes("ws-secret") && !sent.includes("PC-1"),
      "ни людей, ни ПК в запросе к модели",
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM installation WHERE catalog_id IS NOT NULL").get() as { c: number }).c,
      0,
      "подсказка ничего не привязывает",
    );
  } finally {
    config.openaiBaseUrl = saved;
    srv.close();
  }
});
