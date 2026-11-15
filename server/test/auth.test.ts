import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { safeEqual } from "../src/routes/auth.ts";
import {
  createUser,
  hashPassword,
  loginProblem,
  nameProblem,
  passwordProblems,
  randomPassword,
  resetLoginFails,
  verifyPassword,
} from "../src/services/users.ts";

test("сравнение токенов", () => {
  assert.ok(safeEqual("abc", "abc"));
  assert.ok(!safeEqual("abd", "abc") && !safeEqual("ab", "abc") && !safeEqual(undefined, "abc") && !safeEqual("", ""));
});

test("пароли: scrypt с солью, проверка", () => {
  const h = hashPassword("Пароль-123");
  assert.match(h, /^scrypt\$/);
  assert.notEqual(h, hashPassword("Пароль-123"), "соль разная");
  assert.ok(verifyPassword("Пароль-123", h));
  assert.ok(!verifyPassword("пароль-123", h) && !verifyPassword("x", "мусор"));
});

test("правила регистрации: логин, ФИО, пароль", () => {
  assert.equal(loginProblem("ivanov.i"), null);
  for (const bad of ["iv", "1ivanov", "Иванов", "ivan ov", "ivan..ov", "ivanov-", "root"])
    assert.ok(loginProblem(bad), bad);
  assert.equal(nameProblem("Иванов Иван Иванович"), null);
  assert.ok(nameProblem("Иванов") && nameProblem("Иванов 123"));
  assert.deepEqual(passwordProblems("Kedr#Taiga-29", { login: "ivanov", name: "Иванов Иван" }), []);
  const has = (p: string, rule: string, ctx = {}) => passwordProblems(p, ctx).some((x) => x.includes(rule));
  assert.ok(has("Ab1!", "10 символов"));
  assert.ok(
    has("kedr#taiga-29", "заглавная") &&
      has("KEDR#TAIGA-29", "строчная") &&
      has("Kedr#Taiga-xx", "цифра") &&
      has("KedrTaiga29xx", "спецсимвол"),
  );
  assert.ok(has("Keeedr#Taiga-29", "одинаковых"), "aaa");
  assert.ok(has("Kedr#1234-Taiga", "последовательност") && has("Qwer#Kedr-29x", "последовательност"));
  assert.ok(has("Petrova#Kedr29", "логин", { login: "petrova.a" }), "часть логина");
  assert.ok(has("Ivanov#Kedr29", "логин", { login: "ivanov" }) && has("Kedr#Иван-29x", "ФИО", { name: "Иванов Иван" }));
  assert.ok(has("Password!", "распространённых") || has("Password!", "цифра"));
  assert.ok(has("P@ssw0rd!!", "распространённых"), "замены букв не спасают");
  for (let i = 0; i < 20; i++)
    assert.deepEqual(passwordProblems(randomPassword()), [], "сгенерированный пароль проходит правила");
});

/** Приложение в режиме входа по логину (в тестах по умолчанию AUTH=off). */
async function withLogin(
  fn: (app: Awaited<ReturnType<typeof buildApp>>, db: ReturnType<typeof openDb>) => Promise<void>,
) {
  const saved = { mode: config.authMode, token: config.adminToken };
  config.authMode = "login";
  config.adminToken = "s3cret";
  resetLoginFails();
  const db = openDb(":memory:");
  createUser(db, { login: "admin", password: "Admin-pass-1", role: "admin" });
  createUser(db, { login: "viewer", password: "Viewer-pass-1", role: "viewer" });
  const app = await buildApp(db);
  try {
    await fn(app, db);
  } finally {
    await app.close();
    Object.assign(config, { authMode: saved.mode, adminToken: saved.token });
    resetLoginFails();
  }
}
const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers["set-cookie"] ?? "").split(";")[0];

test("вход: без сессии 401, логин ставит HttpOnly SameSite=Strict cookie, выход её гасит; health открыт", () =>
  withLogin(async (app) => {
    const get = (url: string, headers: Record<string, string> = {}) => app.inject({ url, headers });
    assert.equal((await get("/api/health")).statusCode, 200);
    assert.equal((await get("/api/compliance")).statusCode, 401);
    assert.equal((await get("/api/stream")).statusCode, 401, "живая лента тоже закрыта");
    assert.equal((await get("/api/stream?token=s3cret")).statusCode, 401, "токен в адресе больше не принимается");

    assert.equal(
      (await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: "admin", password: "wrong" } }))
        .statusCode,
      401,
    );
    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { login: "ADMIN", password: "Admin-pass-1" },
    });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().user.role, "admin");
    assert.equal(/password_hash|scrypt/.test(JSON.stringify(ok.json())), false, "хеш пароля наружу не уходит");
    const setCookie = String(ok.headers["set-cookie"]);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = cookieOf(ok);
    assert.equal((await get("/api/compliance", { cookie })).statusCode, 200);
    assert.equal((await get("/api/auth/me", { cookie })).json().user.login, "admin");
    assert.equal((await get("/api/compliance", { cookie: "sam_session=ss_поддельная" })).statusCode, 401);

    assert.equal((await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } })).statusCode, 204);
    assert.equal((await get("/api/compliance", { cookie })).statusCode, 401, "после выхода сессия недействительна");
    // скрипты — по ADMIN_TOKEN
    assert.equal((await get("/api/compliance", { authorization: "Bearer s3cret" })).statusCode, 200);
    assert.equal((await get("/api/compliance", { authorization: "Bearer wrong" })).statusCode, 401);
  }));

test("роли и CSRF: просмотр не меняет данные; чужой Origin отклоняется; пользователями управляет только admin", () =>
  withLogin(async (app) => {
    const login = async (l: string, p: string) =>
      cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { login: l, password: p } }));
    const viewer = await login("viewer", "Viewer-pass-1");
    const admin = await login("admin", "Admin-pass-1");
    const post = (url: string, cookie: string, payload: object, origin?: string) =>
      app
        .inject({ method: "POST", url, payload, headers: { cookie, host: "sam.local", ...(origin ? { origin } : {}) } })
        .then((r) => r.statusCode);

    assert.equal(
      (await app.inject({ url: "/api/catalog", headers: { cookie: viewer } })).statusCode,
      200,
      "просмотр читает",
    );
    assert.equal(await post("/api/catalog", viewer, { name: "X" }), 403, "просмотр не пишет");
    assert.equal(await post("/api/ai/chat", viewer, { question: "сколько ПК" }), 200, "но может спрашивать ассистента");
    assert.equal((await app.inject({ url: "/api/users", headers: { cookie: viewer } })).statusCode, 403);

    assert.equal(await post("/api/catalog", admin, { name: "X" }, "http://evil.example"), 403, "CSRF: чужой сайт");
    assert.equal(await post("/api/catalog", admin, { name: "X" }, "http://sam.local"), 201);

    const u = { login: "ivanov", name: "Иванов Иван", role: "viewer", password: "Kedr#Taiga-29" };
    assert.equal(await post("/api/users", admin, { ...u, password: "123" }), 400, "слабый пароль");
    assert.equal(await post("/api/users", admin, { ...u, password: "Ivanov#Taiga9" }), 400, "пароль содержит логин");
    assert.equal(await post("/api/users", admin, { ...u, login: "Ivan Ov" }), 400, "логин с пробелом");
    assert.equal(await post("/api/users", admin, { ...u, name: "Иван" }), 400, "только имя без фамилии");
    assert.equal(await post("/api/users", admin, { ...u, password_confirm: "другой" }), 400, "пароли не совпадают");
    assert.equal(await post("/api/users", admin, { ...u, password_confirm: u.password }), 201);
    assert.equal(await post("/api/users", admin, { ...u }), 409, "логин занят");
    const users = (await app.inject({ url: "/api/users", headers: { cookie: admin } })).json();
    assert.deepEqual(
      users.map((u: { login: string }) => u.login),
      ["admin", "ivanov", "viewer"],
    );
    const adminId = users.find((u: { login: string }) => u.login === "admin").id;
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/users/${adminId}`,
          payload: { role: "viewer" },
          headers: { cookie: admin },
        })
      ).statusCode,
      409,
      "последний admin",
    );
    assert.equal(
      (await app.inject({ method: "DELETE", url: `/api/users/${adminId}`, headers: { cookie: admin } })).statusCode,
      409,
      "себя не удалить",
    );
  }));

test("перебор паролей: после 5 ошибок логин блокируется, даже верный пароль", () =>
  withLogin(async (app) => {
    const tryLogin = (password: string) =>
      app
        .inject({ method: "POST", url: "/api/auth/login", payload: { login: "admin", password } })
        .then((r) => r.statusCode);
    for (let i = 0; i < 5; i++) assert.equal(await tryLogin("wrong"), 401);
    assert.equal(await tryLogin("Admin-pass-1"), 429);
  }));

test("смена пароля сбрасывает все сессии", () =>
  withLogin(async (app) => {
    const cookie = cookieOf(
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { login: "admin", password: "Admin-pass-1" },
      }),
    );
    const ch = (current_password: string) =>
      app.inject({
        method: "POST",
        url: "/api/auth/password",
        headers: { cookie },
        payload: { current_password, new_password: "Kedr#Taiga-30" },
      });
    assert.equal((await ch("wrong")).statusCode, 400);
    assert.equal((await ch("Admin-pass-1")).statusCode, 204);
    assert.equal((await app.inject({ url: "/api/compliance", headers: { cookie } })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/auth/login",
          payload: { login: "admin", password: "Kedr#Taiga-30" },
        })
      ).statusCode,
      200,
    );
  }));

test("агентские адреса — только по агентскому токену; сессия и ADMIN_TOKEN их не открывают", () =>
  withLogin(async (app) => {
    const agent = { "x-ingest-token": "dev-token" };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/ingest/agent",
          headers: agent,
          payload: { serial_number: "A", items: [] },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/ingest/agent", payload: { serial_number: "A", items: [] } }))
        .statusCode,
      401,
    );
    assert.equal((await app.inject({ url: "/api/agent/commands?serial=A", headers: agent })).statusCode, 200);
    assert.equal(
      (await app.inject({ url: "/api/agent/commands?serial=A", headers: { authorization: "Bearer s3cret" } }))
        .statusCode,
      401,
    );
    const r = await app.inject({ url: "/api/health" });
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["access-control-allow-origin"], undefined, "CORS по умолчанию выключен");
  }));

test("устройство по числовому id: id выдаётся сам, старые ссылки по серийнику работают", async () => {
  const db = openDb(":memory:");
  const app = await buildApp(db);
  for (const s of ["VMware-56 4d ad", "B1RG0S2"])
    await app.inject({
      method: "POST",
      url: "/api/ingest/agent",
      headers: { "x-ingest-token": "dev-token" },
      payload: { serial_number: s, hostname: s, items: [] },
    });
  const list = (await app.inject({ url: "/api/devices" })).json() as { id: number; serial_number: string }[];
  const vm = list.find((d) => d.serial_number.startsWith("VMware"))!;
  assert.ok(Number.isInteger(vm.id) && vm.id > 0);
  assert.equal(new Set(list.map((d) => d.id)).size, 2, "id уникальны");
  assert.equal((await app.inject({ url: `/api/devices/${vm.id}` })).json().device.serial_number, "VMware-56 4d ad");
  assert.equal(
    (await app.inject({ url: `/api/devices/${encodeURIComponent("VMware-56 4d ad")}` })).json().device.id,
    vm.id,
  );
  assert.equal((await app.inject({ url: "/api/devices/99999" })).statusCode, 404);
  // повторный снимок (upsert) id не меняет
  await app.inject({
    method: "POST",
    url: "/api/ingest/agent",
    headers: { "x-ingest-token": "dev-token" },
    payload: { serial_number: "VMware-56 4d ad", hostname: "NEW", items: [] },
  });
  assert.equal((await app.inject({ url: `/api/devices/${vm.id}` })).json().device.hostname, "NEW");
  await app.close();
});

test("выданный пароль: до смены доступны только /api/auth/*; после смены — обычный вход", () =>
  withLogin(async (app) => {
    const login = (l: string, p: string) =>
      app.inject({ method: "POST", url: "/api/auth/login", payload: { login: l, password: p } });
    const admin = cookieOf(await login("admin", "Admin-pass-1"));
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: admin },
      payload: { login: "petrova", name: "Петрова Анна", role: "viewer", password: "Kedr#Taiga-29" },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().must_change_password, true, "пароль выдал администратор");

    const first = await login("petrova", "Kedr#Taiga-29");
    assert.equal(first.json().user.must_change_password, true);
    const cookie = cookieOf(first);
    const blocked = await app.inject({ url: "/api/compliance", headers: { cookie } });
    assert.equal(blocked.statusCode, 403);
    assert.equal(blocked.json().change_password, true);
    assert.equal((await app.inject({ url: "/api/auth/me", headers: { cookie } })).statusCode, 200);

    const change = await app.inject({
      method: "POST",
      url: "/api/auth/password",
      headers: { cookie },
      payload: { current_password: "Kedr#Taiga-29", new_password: "Sosna!Reka-47" },
    });
    assert.equal(change.statusCode, 204);
    const again = await login("petrova", "Sosna!Reka-47");
    assert.equal(again.json().user.must_change_password, false);
    assert.equal((await app.inject({ url: "/api/compliance", headers: { cookie: cookieOf(again) } })).statusCode, 200);
  }));
