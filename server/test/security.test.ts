import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/app.ts";
import { config } from "../src/config.ts";
import { likeContains, openDb } from "../src/db.ts";
import { llm, LlmBusy } from "../src/services/ai.ts";
import { maskKeys } from "../src/services/licensePool.ts";
import { runReadOnly, SqlTimeout } from "../src/services/sqlWorker.ts";
import { createUser, resetLoginFails } from "../src/services/users.ts";

test("ключи лицензий в тексте маскируются (остаются 5 последних символов)", () => {
  assert.equal(
    maskKeys("Серийный номер: 50501-C0000-04RTY-UIO56-3MN8R."),
    "Серийный номер: •••••-•••••-•••••-•••••-3MN8R.",
  );
  assert.equal(maskKeys("ключ 4040E-Q0000-0AB1C-D2E3F-7KX2M, срок"), "ключ •••••-•••••-•••••-•••••-7KX2M, срок");
  assert.equal(maskKeys("версия 5.0.12000, дата 2026-11-14"), "версия 5.0.12000, дата 2026-11-14", "прочее не трогаем");
});

test("вход с чужого сайта (login CSRF) отклоняется; со своего — нет", async () => {
  const saved = config.authMode;
  config.authMode = "login";
  resetLoginFails();
  const db = openDb(":memory:");
  createUser(db, { login: "viewer", password: "Kedr#Taiga-29", role: "viewer" });
  const app = await buildApp(db);
  try {
    const go = (origin?: string) =>
      app
        .inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { login: "viewer", password: "Kedr#Taiga-29" },
          headers: { host: "sam.local", ...(origin ? { origin } : {}) },
        })
        .then((r) => r.statusCode);
    assert.equal(await go("http://evil.example"), 403);
    assert.equal(await go("http://sam.local"), 200);
    assert.equal(await go(), 200, "без Origin (curl, скрипты) — можно");
  } finally {
    config.authMode = saved;
    await app.close();
    resetLoginFails();
  }
});

test("SQL от модели: отдельный поток, только чтение, таймаут не вешает сервер", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-sql-"));
  const path = join(dir, "t.db");
  const db = openDb(path);
  db.exec("INSERT INTO employee (full_name) VALUES ('Иванов'), ('Петров')");
  try {
    assert.deepEqual(
      (await runReadOnly(db, "SELECT ulower(full_name) AS n FROM employee ORDER BY n")).map((r) => r.n),
      ["иванов", "петров"],
    );
    assert.equal(
      (await runReadOnly(db, "SELECT COUNT(*) AS n FROM employee WHERE lower(full_name) = 'иванов'"))[0].n,
      1,
      "lower() понимает кириллицу",
    );
    await assert.rejects(
      runReadOnly(db, "DELETE FROM employee"),
      /readonly|read-only|только/i,
      "соединение только для чтения",
    );
    // тяжёлый запрос: рекурсия на миллиарды строк → таймаут, а основной поток в это время свободен
    const t0 = Date.now();
    let ticks = 0;
    const iv = setInterval(() => ticks++, 50);
    await assert.rejects(
      runReadOnly(db, "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) FROM c", 600),
      SqlTimeout,
    );
    clearInterval(iv);
    assert.ok(Date.now() - t0 < 3000 && ticks >= 5, "основной поток не блокировался");
    assert.equal((db.prepare("SELECT COUNT(*) c FROM employee").get() as { c: number }).c, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ИИ-модель: сверх лимита одновременных запросов — «занята», а не очередь", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const srv = createServer((_q, res) => {
    void gate.then(() => res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] })));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const saved = { url: config.openaiBaseUrl, max: config.llmMaxConcurrent };
  Object.assign(config, {
    openaiBaseUrl: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`,
    llmMaxConcurrent: 1,
  });
  try {
    const first = llm([{ role: "user", content: "a" }], false);
    await assert.rejects(llm([{ role: "user", content: "b" }], false), LlmBusy);
    release();
    assert.equal(await first, "ok");
    assert.equal(await llm([{ role: "user", content: "c" }], false), "ok", "после ответа — снова свободна");
  } finally {
    Object.assign(config, { openaiBaseUrl: saved.url, llmMaxConcurrent: saved.max });
    srv.close();
  }
});

test("поиск: %, _ и \\ ищутся буквально", async () => {
  assert.equal(likeContains("50%_\\"), "%50\\%\\_\\\\%");
  assert.equal(likeContains(""), null);
  const db = openDb(":memory:");
  for (const n of ["100% Free", "100 Free", "a_b tool", "axb tool"])
    db.prepare("INSERT INTO software_catalog (name) VALUES (?)").run(n);
  db.prepare(
    "INSERT INTO employee (full_name, department) VALUES ('Иванов Иван', 'ИТ_отдел'), ('Петров Пётр', 'ИТ-отдел')",
  ).run();
  const app = await buildApp(db);
  const get = async (url: string) => (await app.inject({ url })).json();
  const names = (r: { items: { name: string }[] }) => r.items.map((i) => i.name).sort();
  try {
    assert.deepEqual(names(await get("/api/catalog?q=" + encodeURIComponent("100%"))), ["100% Free"]);
    assert.deepEqual(names(await get("/api/catalog?q=a_b")), ["a_b tool"]);
    const emps = (await get("/api/employees?q=" + encodeURIComponent("ит_"))) as { full_name: string }[];
    assert.deepEqual(
      emps.map((e) => e.full_name),
      ["Иванов Иван"],
    );
  } finally {
    await app.close();
  }
});

test("страницы фронта и API: заголовки безопасности, CSP у страниц", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-web-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  const saved = config.webDist;
  config.webDist = dir;
  const app = await buildApp(openDb(":memory:"));
  try {
    for (const url of ["/", "/dashboard"]) {
      const h = (await app.inject({ url })).headers;
      const csp = String(h["content-security-policy"]);
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /img-src 'self' data: blob:/);
      assert.match(csp, /connect-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(h["x-content-type-options"], "nosniff");
      assert.equal(h["x-frame-options"], "DENY");
      assert.equal(h["referrer-policy"], "no-referrer");
    }
    const api = (await app.inject({ url: "/api/health" })).headers;
    assert.equal(api["x-frame-options"], "DENY");
    assert.equal(api["content-security-policy"], undefined, "JSON-ответам CSP не нужна");
  } finally {
    config.webDist = saved;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("секреты наружу не уходят: /downloads — только exe и ps1, полные ключи — только агенту-адресату", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sam-agent-"));
  for (const f of ["sam-agent.exe", "install-sam-agent.ps1", "sam-agent.json", "ТЕСТ.md"])
    writeFileSync(join(dir, f), "x");
  const saved = config.agentDist;
  config.agentDist = dir;
  const db = openDb(":memory:");
  const app = await buildApp(db);
  try {
    const status = async (url: string) => (await app.inject({ url })).statusCode;
    assert.equal(await status("/downloads/sam-agent.exe"), 200);
    assert.equal(await status("/downloads/install-sam-agent.ps1"), 200);
    assert.equal(await status("/downloads/sam-agent.json"), 404, "файл с ключом регистрации не раздаётся");
    assert.equal(await status("/downloads/" + encodeURIComponent("ТЕСТ.md")), 404);
    assert.equal(await status("/downloads/../package.json"), 404);

    const full = "50501-C0000-04RTY-UIO56-3MN8R";
    const add = await app.inject({
      method: "POST",
      url: "/api/license-pool",
      payload: { product: "cryptopro_csp", title: "k", license_key: full, seats: 2 },
    });
    assert.equal(add.statusCode, 201);
    const sek = (await app.inject({ method: "POST", url: "/api/agent-enroll-keys", payload: { title: "t" } })).json()
      .key as string;
    for (const url of ["/api/license-pool", "/api/license-products", "/api/agent-enroll-keys", "/api/agent-commands"]) {
      const body = (await app.inject({ url })).body;
      assert.ok(!body.includes(full) && !body.includes(sek), `${url}: полный ключ не отдаётся`);
    }
  } finally {
    config.agentDist = saved;
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
