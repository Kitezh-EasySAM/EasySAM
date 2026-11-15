import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.ts";
import { config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { answerByRules, chat, guardSql } from "../src/services/ai.ts";
import { importRows, mapColumns, parseDate, template } from "../src/services/importer.ts";
import { applySnapshot } from "../src/services/ingest.ts";
import { applyUsage } from "../src/services/processes.ts";
import { notifications } from "../src/services/notifications.ts";
import { reallocation } from "../src/services/reallocation.ts";
import { parseXlsx } from "../src/services/tabular.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;

const old = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 19).replace("T", " ");

/** 4 ПК с Office при 2 купленных местах: A — уволенный, B — давно не запускал, C и D — активные. */
function demo() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO software_catalog (id, name, license_kind, internal_status, list_price) VALUES
      (1, 'Microsoft Office', 'commercial', 'current', 15000), (2, 'WinRAR', 'shareware', 'forbidden', 3000), (3, 'Google Chrome', 'freeware', 'current', NULL);
    INSERT INTO license_purchase (catalog_id, seats, unit_price, valid_until, contract) VALUES (1, 2, 15000, NULL, 'Д-1');
    INSERT INTO employee (id, full_name, department, active) VALUES (1, 'Уволенный Пётр', 'ИТ', 0), (2, 'Соколова Анна', 'Дизайн', 1), (3, 'Иванов Иван', 'ИТ', 1), (4, 'Петров Олег', 'ИТ', 1);`);
  for (const [sn, emp, extra] of [
    ["A", 1, []],
    ["B", 2, []],
    ["C", 3, [{ name: "WinRAR" }]],
    ["D", 4, [{ name: "Google Chrome" }]],
  ] as const) {
    applySnapshot(db, { serial_number: sn, hostname: `WS-${sn}`, items: [{ name: "Microsoft Office" }, ...extra] });
    db.prepare("UPDATE device SET employee_id = ? WHERE serial_number = ?").run(emp, sn);
  }
  db.prepare("UPDATE installation SET last_used = ? WHERE device_serial = 'B'").run(old(200));
  db.prepare("UPDATE installation SET last_used = ? WHERE device_serial IN ('C','D')").run(old(1));
  return db;
}

test("перенос лицензий: уволенный и давно не запускавший — доноры; нехватка 2 закрывается без закупки; запрещённое не переносим", () => {
  const r = reallocation(demo());
  const office = r.items.find((i) => i.name === "Microsoft Office")!;
  assert.deepEqual([office.deficit, office.covered, office.remaining_deficit, office.savings], [2, 2, 0, 30000]);
  assert.deepEqual(
    office.donors.map((d) => d.device_serial),
    ["A", "B"],
    "уволенный первым",
  );
  assert.match(office.donors[0].reason!, /уволен/);
  assert.match(office.donors[1].reason!, /не запускалась 200 дн/);
  assert.ok(!r.items.some((i) => i.name === "WinRAR"), "запрещённое ПО удаляют, а не переносят");
});

test("колокольчик: нехватка (без слова «превышение»), запрещённое, неопознанное; стабильные id", () => {
  const db = demo();
  applySnapshot(db, {
    serial_number: "D",
    hostname: "WS-D",
    items: [{ name: "Microsoft Office" }, { name: "Google Chrome" }, { name: "Странная программа" }],
  });
  const n = notifications(db);
  const titles = n.items.map((x) => x.title);
  assert.ok(titles.includes("Не хватает лицензий: Microsoft Office"));
  assert.ok(titles.includes("Запрещённое ПО: WinRAR"));
  assert.ok(n.items.some((x) => x.level === "info" && x.link === "/catalog/unmatched"));
  assert.ok(!JSON.stringify(n).includes("Превышение"));
  assert.deepEqual(
    notifications(db).items.map((x) => x.id),
    n.items.map((x) => x.id),
    "id стабильны",
  );
  assert.equal(n.items[0].level, "red");
});

test("колокольчик: договоры, запуски запрещённого и portable, агенты без связи — все ветки", () => {
  const db = demo();
  const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO license_purchase (catalog_id, seats, valid_until, contract) VALUES (1, 5, ?, 'Д-2')").run(
    day(10),
  );
  db.prepare("INSERT INTO license_purchase (catalog_id, seats, valid_until, contract) VALUES (1, 3, ?, NULL)").run(
    day(-20),
  );
  db.prepare("UPDATE device SET agent_last_seen = ? WHERE serial_number IN ('A', 'B')").run(old(10));
  const now = new Date().toISOString();
  const run = (exe: string, path: string) => ({ exe, path, first_seen: now, last_seen: now });
  applyUsage(db, "C", [run("WinRAR.exe", "C:\\Program Files\\WinRAR\\WinRAR.exe")]);
  applyUsage(db, "D", [run("qbittorrent.exe", "C:\\Users\\u\\Downloads\\qbittorrent.exe")]);
  const n = notifications(db);
  const by = (prefix: string) => n.items.find((x) => x.id.startsWith(prefix));
  assert.match(by("purchase-exp-")!.text, /5 мест до .+ \(через \d+ дн\.\), Д-2/);
  assert.match(by("purchase-expired-")!.title, /Истёк договор: Microsoft Office/);
  assert.equal(by("agents-lost-")!.text, "2 ПК");
  assert.equal(by("proc-forbidden-")!.level, "red");
  assert.match(by("proc-portable-")!.text, /1 программа из Загрузок/);
  assert.deepEqual(
    n.items.map((x) => x.level),
    [...n.items.map((x) => x.level)].sort(
      (a, b) => ["red", "yellow", "info"].indexOf(a) - ["red", "yellow", "info"].indexOf(b),
    ),
    "важные первыми",
  );
  assert.equal(n.counts.total, n.items.length);
});

test("ассистент по правилам: сколько/у кого (с синонимами), перенос, нехватка, цена, ПК сотрудника, помощь", () => {
  const db = demo();
  const a = answerByRules(db, "У скольких человек установлен офис?")!;
  assert.match(a.answer, /Microsoft Office установлен на 4 ПК, у 4 сотрудников\. Куплено лицензий: 2 — не хватает 2/);
  assert.equal(a.table!.rows.length, 4);
  assert.match(answerByRules(db, "у кого стоит хром")!.answer, /Google Chrome установлен на 1 ПК, у 1 сотрудника/);
  assert.match(answerByRules(db, "что можно перенести?")!.answer, /перераспределить 2 лиц\. без закупки/);
  assert.match(answerByRules(db, "чего не хватает")!.answer, /не хватает по 1 программам/);
  assert.match(
    answerByRules(db, "сколько стоит office")!.answer,
    /15\s000 ₽ за место; действующие договоры — 2 места на 30\s000 ₽/,
  );
  assert.match(answerByRules(db, "что установлено у Соколовой?")!.answer, /WS-B \(Соколова Анна\)/);
  assert.equal(answerByRules(db, "у кого запрещённое")!.intent, "forbidden");
  assert.ok(
    answerByRules(db, "помощь")!.suggestions!.length >= 1,
    "вопросы по текущим данным, а не заготовленные примеры",
  );
  assert.equal(answerByRules(db, "какая погода в сургуте"), null);
});

test("SQL от модели: только SELECT по белому списку, без секретных таблиц; LIMIT добавляется", () => {
  assert.match(guardSql("SELECT hostname FROM device"), /LIMIT 200$/);
  assert.equal(
    guardSql("select 1 from device limit 5000000;"),
    "SELECT * FROM (select 1 from device limit 5000000) LIMIT 200",
    "свой LIMIT модели не снимает ограничение",
  );
  for (const bad of [
    "DELETE FROM device",
    "SELECT * FROM device; DROP TABLE device",
    "SELECT * FROM license_pool",
    "SELECT * FROM agent_token",
    "SELECT * FROM sqlite_master",
    "PRAGMA table_info(device)",
    "SELECT * FROM device JOIN evil ON 1",
    "SELECT * FROM device, license_pool",
    "SELECT (SELECT login FROM app_user) FROM device",
    "SELECT * FROM device WHERE 1 IN (SELECT 1 FROM user_session)",
    "SELECT * FROM pragma_table_info('device')",
    "ATTACH DATABASE 'x.db' AS x",
  ])
    assert.throws(() => guardSql(bad), Error, bad);
  assert.doesNotThrow(() => guardSql("WITH x AS (SELECT * FROM device) SELECT * FROM x"));
  assert.throws(
    () => guardSql("SELECT * FROM device, new_secret", ["new_secret"]),
    /new_secret/,
    "таблицы вне белого списка закрыты",
  );
});

test("ассистент через LLM (фальшивый OpenAI-сервер): SQL выполняется только на чтение; опасный SQL отклоняется", async () => {
  const db = demo();
  const sent: string[] = [];
  let sql =
    "SELECT d.hostname, e.full_name FROM device d JOIN employee e ON e.id = d.employee_id WHERE e.department = 'ИТ' ORDER BY d.hostname";
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      sent.push(b);
      const body = JSON.parse(b);
      const wantsSql = String(body.messages[0].content).includes("SQLite");
      const content = wantsSql
        ? `<think>...</think>${JSON.stringify({ sql, title: "ПК отдела ИТ" })}`
        : "В отделе ИТ три ПК.";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const saved = config.openaiBaseUrl;
  config.openaiBaseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const a = await chat(db, "Какие ПК в отделе ИТ?");
    assert.deepEqual([a.source, a.answer, a.table!.rows.length], ["llm", "ПК отдела ИТ. Найдено строк: 3.", 3]);
    assert.equal(sent.length, 1, "результат запроса (ФИО) в модель не отправляется");
    assert.match(a.sql!, /LIMIT 200$/);
    sql = "DELETE FROM device";
    const b = await chat(db, "Удали все ПК пожалуйста");
    assert.match(b.answer, /безопасный запрос: разрешён только SELECT/);
    assert.equal((db.prepare("SELECT COUNT(*) c FROM device").get() as { c: number }).c, 4, "ничего не удалено");
    // после ответа соединение снова пишет
    db.exec("INSERT INTO employee (full_name) VALUES ('Новый')");
  } finally {
    config.openaiBaseUrl = saved;
    srv.close();
  }
});

test("импорт: даты, сопоставление колонок, формат организаторов, предпросмотр без записи, ошибки по строкам", async () => {
  assert.equal(parseDate("31.12.2027"), "2027-12-31");
  assert.equal(parseDate("2027-12-31"), "2027-12-31");
  assert.equal(parseDate("бессрочно"), null);
  assert.equal(parseDate("46022"), "2025-12-31");
  assert.equal(parseDate("когда-нибудь"), "bad");
  // формат «Пример перечня софта»: шапка не в первой строке
  assert.equal(
    mapColumns([[""], ["Наименование БПО", "Версия БПО", "Краткое назначение БПО"], ["Git", "2.49", "VCS"]], "catalog")
      .header,
    1,
  );

  const db = demo();
  const preview = importRows(
    db,
    "employees",
    [
      ["ФИО", "Отдел", "ПК"],
      ["Новикова Ольга", "Маркетинг", "A"],
      ["Соколова Анна", "Продажи", ""],
      ["", "", ""],
    ],
    true,
  );
  assert.deepEqual([preview.created, preview.updated, preview.dry_run], [1, 1, true]);
  assert.equal(
    (db.prepare("SELECT COUNT(*) c FROM employee WHERE full_name = 'Новикова Ольга'").get() as { c: number }).c,
    0,
    "предпросмотр не пишет",
  );

  const emp = importRows(db, "employees", [
    ["ФИО", "Отдел", "ПК"],
    ["Новикова Ольга", "Маркетинг", "A"],
    ["Соколова Анна", "Продажи", ""],
  ]);
  assert.deepEqual([emp.created, emp.updated], [1, 1]);
  assert.equal(
    (
      db
        .prepare("SELECT e.full_name FROM device d JOIN employee e ON e.id = d.employee_id WHERE d.serial_number = 'A'")
        .get() as { full_name: string }
    ).full_name,
    "Новикова Ольга",
  );

  const cat = importRows(db, "catalog", [
    ["Наименование", "Тип лицензии", "Статус", "Реестр РФ", "Цена", "Лицензионное соглашение"],
    ["КОМПАС-3D", "коммерческая", "актуальный", "да", "60 000", "Лицензионный договор АСКОН"],
    ["Google Chrome", "", "устаревший", "", "", ""],
    ["Плохое", "", "непонятный", "", "", ""],
  ]);
  assert.deepEqual([cat.created, cat.updated, cat.errors.length, cat.errors[0].row], [1, 1, 1, 4]);
  const k = db
    .prepare(
      "SELECT license_kind, in_ru_registry, list_price, license_type_id FROM software_catalog WHERE name = 'КОМПАС-3D'",
    )
    .get() as Row;
  assert.deepEqual(
    [k.license_kind, k.in_ru_registry, k.list_price, !!k.license_type_id],
    ["commercial", 1, 60000, true],
  );
  assert.equal(
    (db.prepare("SELECT internal_status FROM software_catalog WHERE name = 'Google Chrome'").get() as Row)
      .internal_status,
    "outdated",
  );

  const pur = importRows(db, "purchases", [
    ["ПО", "Мест", "Цена", "Действует до", "Договор"],
    ["КОМПАС-3D", "10", "60000", "31.12.2027", "Д-9"],
    ["КОМПАС-3D", "12", "60000", "31.12.2027", "Д-9"],
    ["Нет такого", "1", "", "", ""],
    ["КОМПАС-3D", "много", "", "", ""],
  ]);
  assert.deepEqual([pur.created, pur.updated, pur.errors.map((e) => e.row)], [1, 1, [4, 5]]);
  assert.match(pur.errors[0].error, /нет в каталоге/);
  assert.equal(
    (db.prepare("SELECT seats FROM license_purchase WHERE contract = 'Д-9'").get() as Row).seats,
    12,
    "тот же договор — обновление, не дубль",
  );

  assert.throws(() => importRows(db, "purchases", [["что-то", "ещё"]]), /не найдены колонки: ПО, Мест/);
  // шаблон читается обратно и импортируется
  const rows = await parseXlsx(await template("purchases"));
  assert.deepEqual(rows[0].slice(0, 5), ["ПО", "Мест", "Цена", "Действует до", "Договор"]);
});

test("API: чат, подсказки, перенос, колокольчик, импорт файлом с предпросмотром, шаблон", async () => {
  const app = await buildApp(demo());
  const chatR = await app.inject({
    method: "POST",
    url: "/api/ai/chat",
    payload: { question: "у кого стоит WinRAR?" },
  });
  assert.equal(chatR.json().intent, "who_has");
  assert.equal((await app.inject({ method: "POST", url: "/api/ai/chat", payload: { question: "" } })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/ai/info" })).json().examples.length >= 5, true);
  // «с чего начать» — из текущих данных: у каждой карточки есть число и вопрос, на который правила отвечают непусто
  const st = (await app.inject({ url: "/api/ai/info" })).json().starters as {
    title: string;
    value: string;
    question: string;
  }[];
  assert.ok(st.length >= 2 && st.length <= 4);
  for (const x of st) {
    assert.match(x.value, /\d/);
    const ans = (await app.inject({ method: "POST", url: "/api/ai/chat", payload: { question: x.question } })).json();
    assert.equal(ans.source, "rules", x.question);
    assert.ok(ans.table?.rows.length > 0, `пустой ответ на «${x.question}»`);
  }
  const empty = await buildApp(openDb(":memory:"));
  assert.deepEqual((await empty.inject({ url: "/api/ai/info" })).json().starters, [], "пустая база — без карточек");
  await empty.close();
  assert.equal((await app.inject({ url: "/api/licenses/reallocation" })).json().total_covered, 2);
  assert.ok((await app.inject({ url: "/api/notifications" })).json().counts.red >= 2);
  const csv = "ФИО;Отдел\nНовый Сотрудник;ИТ\n";
  const b = "----x";
  const mp = (name: string, content: string) => ({
    payload: `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n\r\n${content}\r\n--${b}--\r\n`,
    headers: { "content-type": `multipart/form-data; boundary=${b}` },
  });
  const dry = await app.inject({ method: "POST", url: "/api/import/employees?dry_run=1", ...mp("e.csv", csv) });
  assert.deepEqual([dry.statusCode, dry.json().created, dry.json().dry_run], [200, 1, true]);
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/import/employees", ...mp("e.csv", csv) })).json().created,
    1,
  );
  assert.equal(
    (await app.inject({ method: "POST", url: "/api/import/purchases", ...mp("p.csv", "a;b\n1;2\n") })).statusCode,
    400,
  );
  assert.equal((await app.inject({ method: "POST", url: "/api/import/robots", ...mp("p.csv", csv) })).statusCode, 404);
  const t = await app.inject({ url: "/api/import/templates/catalog.xlsx" });
  assert.deepEqual([t.statusCode, t.headers["content-type"]?.toString().includes("spreadsheetml")], [200, true]);
  await app.close();
});
