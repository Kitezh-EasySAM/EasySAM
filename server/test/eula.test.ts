import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.ts";
import { config } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { eulaTarget, parseJsonReply, stripThink } from "../src/services/ai.ts";
import {
  analyzeByRules,
  analyzeEula,
  approveSoftware,
  FetchError,
  htmlToText,
  isPrivateAddress,
  looksLikeUrl,
  safeFetch,
} from "../src/services/eula.ts";
import { stripTags } from "../src/services/safeFetch.ts";

test("SSRF: внутренние адреса запрещены, внешние — нет", async () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.249.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.1.1",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "224.0.0.1",
  ])
    assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "77.88.55.80", "2a02:6b8::2:242"]) assert.ok(!isPrivateAddress(ip), ip);
  // настоящий сервер на 127.0.0.1 — не скачивается ни напрямую, ни через имя localhost
  const srv = createServer((_q, r) => r.end("<html>secret</html>"));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  try {
    await assert.rejects(safeFetch(`http://127.0.0.1:${port}/`), FetchError);
    await assert.rejects(safeFetch(`http://localhost:${port}/`), FetchError);
    await assert.rejects(safeFetch(`http://[::1]:${port}/`), FetchError);
    await assert.rejects(safeFetch("file:///etc/passwd"), /только http/);
    await assert.rejects(safeFetch("http://user:pass@example.com/"), /логином/);
  } finally {
    srv.close();
  }
});

test("HTML → текст: без скриптов, сущности, ссылки на лицензию", () => {
  const h = `<html><head><title>7-Zip &amp; Co</title><script>evil()</script></head><body><nav>menu</nav>
    <p>Free&nbsp;archiver &laquo;7z&raquo;</p><a href="/license.txt">License</a><a href="/download">Download</a></body></html>`;
  const r = htmlToText(h, "https://www.7-zip.org/");
  assert.equal(r.title, "7-Zip & Co");
  assert.ok(r.text.includes("Free archiver «7z»") && !r.text.includes("evil") && !r.text.includes("menu"));
  assert.deepEqual(r.licenseLinks, ["https://www.7-zip.org/license.txt"]);
});

test("HTML → текст: ссылка на лицензию в подвале, перенос по <br> и </p>, «<>» остаётся", () => {
  const h = `<p>One</p>Two<BR/>Three <> four<footer><a href="/eula.html">Terms</a></footer>`;
  const r = htmlToText(h, "https://ex.org/");
  assert.equal(r.text, "One\nTwo\nThree <> four");
  assert.deepEqual(r.licenseLinks, ["https://ex.org/eula.html"]);
  assert.equal(stripTags("a<b>c</b><i"), "a c <i");
});

test("HTML → текст: враждебная страница 2 МБ разбирается быстро (линейно, без ReDoS)", () => {
  for (const bad of ["<".repeat(2_000_000), "<a ".repeat(600_000), "<script>".repeat(250_000)]) {
    const t = performance.now();
    htmlToText(bad);
    assert.ok(performance.now() - t < 2000, `${bad.slice(0, 8)}… разбирался ${Math.round(performance.now() - t)} мс`);
  }
});

test("правила: распознают лицензии и запреты", () => {
  assert.deepEqual(
    [
      analyzeByRules("Permission is hereby granted, free of charge, to any person").license_name,
      analyzeByRules("MIT License").commercial_use,
    ],
    ["MIT", "allowed"],
  );
  const gpl = analyzeByRules("GNU GENERAL PUBLIC LICENSE Version 3, 29 June 2007");
  assert.deepEqual([gpl.license_name, gpl.copyleft, gpl.license_kind], ["GNU GPL v3", true, "open_source"]);
  const home = analyzeByRules("This software is free for personal use only. Commercial use is prohibited.");
  assert.equal(home.commercial_use, "forbidden");
  assert.ok(home.risks[0].quote!.includes("personal use only"));
  const trial = analyzeByRules("You may use the software during a 30-day evaluation period. All rights reserved.");
  assert.equal(trial.license_kind, "trial");
  assert.equal(
    analyzeByRules("Программа распространяется только для некоммерческого использования").commercial_use,
    "forbidden",
  );
});

test("ссылка или название в вопросе → проверка лицензии", () => {
  assert.equal(eulaTarget("проверь https://www.7-zip.org/license.txt пожалуйста"), "https://www.7-zip.org/license.txt");
  assert.equal(eulaTarget("Проверь лицензию 7-Zip"), "7-Zip");
  // кнопка «Заполнить с ИИ»: окончание «-ое» и «ПО:» не должны попадать в название (в JS \w не понимает кириллицу)
  assert.equal(
    eulaTarget("Добавь в одобренное ПО: Kaspersky Security 10 для Windows Server"),
    "Kaspersky Security 10 для Windows Server",
  );
  assert.equal(eulaTarget("добавь в одобренные winrar"), "winrar");
  assert.equal(eulaTarget("Добавь в одобренное ПО «Почта Mail.ru»"), "Почта Mail.ru");
  assert.equal(eulaTarget("Проверь лицензию Полиглот"), "Полиглот", "«По» в начале названия — не слово «ПО»");
  assert.equal(eulaTarget("Можно ли использовать TeamViewer?"), "TeamViewer");
  assert.equal(eulaTarget("добавь в одобренное"), null, "раньше отдавало «е» — хвост окончания");
  assert.equal(eulaTarget("проверь лицензию\n  7-Zip"), "7-Zip");
  assert.equal(eulaTarget("Какие лицензии можно перенести и куда?"), null);
  assert.equal(eulaTarget("У кого стоит WinRAR?"), null);
  assert.ok(looksLikeUrl("www.7-zip.org") && looksLikeUrl("7-zip.org/license.txt") && !looksLikeUrl("7-Zip"));
});

test("ответ модели: убираем <think>, достаём JSON из текста", () => {
  assert.equal(stripThink("<think>долго думаю</think>\nОтвет"), "Ответ");
  assert.deepEqual(parseJsonReply('<think>x</think>Вот: ```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonReply('Результат {"a": 2} готово'), { a: 2 });
});

test("анализ по ссылке (подставной загрузчик): дочитывает страницу лицензии; затем «в одобренное ПО»", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO device (serial_number, hostname) VALUES ('S1', 'PC1')").run();
  db.prepare(
    "INSERT INTO installation (device_serial, raw_name, norm_name, is_noise) VALUES ('S1', 'Foo Archiver 2.1', 'foo archiver', 0)",
  ).run();
  const pages: Record<string, string> = {
    "https://foo.example/": `<title>Foo Archiver — free</title><p>Best archiver</p><a href="https://foo.example/eula">EULA</a>`,
    "https://foo.example/eula": "<pre>Foo Archiver is free for personal use only. Commercial use is prohibited.</pre>",
  };
  const fetcher = async (u: string) => {
    if (!pages[u]) throw new FetchError("404");
    return { url: u, html: pages[u] };
  };
  const a = await analyzeEula(db, "https://foo.example/", fetcher as typeof safeFetch);
  assert.deepEqual(
    [a.input_kind, a.commercial_use, a.verdict, a.suggested_status, a.source],
    ["url", "forbidden", "reject", "forbidden", "rules"],
  );
  assert.deepEqual(a.sources, ["https://foo.example/", "https://foo.example/eula"]);
  assert.equal(a.name, "Foo Archiver");

  const ok = await analyzeEula(db, "7-Zip");
  assert.deepEqual([ok.input_kind, ok.license_kind, ok.verdict], ["name", "open_source", "approve"]);

  const r = approveSoftware(db, {
    name: "Foo Archiver",
    vendor: "Foo Inc",
    license_kind: "freeware",
    internal_status: "forbidden",
    license_name: "Foo EULA",
    commercial_use: "forbidden",
    analysis: a,
  });
  assert.equal(r.created, true);
  assert.equal(r.linked_installations, 1, "точное совпадение из «Неопознанного» привязано");
  const lt = db
    .prepare("SELECT commercial_use, eula_analysis FROM license_type WHERE id = ?")
    .get(r.license_type_id!) as { commercial_use: number; eula_analysis: string };
  assert.equal(lt.commercial_use, 0);
  assert.equal(JSON.parse(lt.eula_analysis).verdict, "reject");
  const again = approveSoftware(db, { name: "foo archiver", license_kind: "commercial", internal_status: "current" });
  assert.deepEqual([again.created, again.catalog_id], [false, r.catalog_id], "повтор обновляет, а не дублирует");
  assert.equal((await analyzeEula(db, "Foo Archiver")).existing?.id, r.catalog_id, "уже в каталоге — сообщаем");
});

test("анализ с моделью (подставной OpenAI-совместимый сервер) и API", async () => {
  const sent: { body: Record<string, unknown> }[] = [];
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      sent.push({ body: JSON.parse(b) });
      const content = `<think>рассуждаю</think>{"name": "Bar Studio", "vendor": "Bar LLC", "license_name": "Bar EULA", "license_kind": "commercial",
        "commercial_use": "allowed", "copyleft": false, "subscription": true, "summary": "Можно использовать по подписке.", "risks": [{"point": "Подписка", "quote": null}]}`;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const saved = config.openaiBaseUrl;
  config.openaiBaseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  const app = await buildApp(openDb(":memory:"));
  try {
    const r = await app.inject({
      method: "POST",
      url: "/api/ai/eula",
      payload: { input: "Bar Studio — subscription license agreement. ".repeat(10) },
    });
    assert.equal(r.statusCode, 200);
    const a = r.json();
    assert.deepEqual(
      [a.source, a.name, a.subscription, a.verdict, a.input_kind],
      ["llm", "Bar Studio", true, "approve", "text"],
    );
    assert.equal(sent[0].body.reasoning_effort, "none", "у локальной модели рассуждения выключены");
    assert.equal(sent[0].body.response_format, undefined, "LM Studio не понимает json_object");
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/ai/eula", payload: { input: "http://127.0.0.1:1/" } })).statusCode,
      400,
      "внутренняя сеть — 400",
    );
    const ap = await app.inject({
      method: "POST",
      url: "/api/ai/eula/approve",
      payload: {
        name: a.name,
        vendor: a.vendor,
        license_kind: a.license_kind,
        internal_status: "current",
        license_name: a.license_name,
        analysis: a,
      },
    });
    assert.equal(ap.statusCode, 201);
    assert.equal(
      (await app.inject({ url: `/api/catalog/${ap.json().catalog_id}` })).json().license_type_name,
      "Bar EULA",
    );
    const info = (await app.inject({ url: "/api/ai/info" })).json();
    assert.equal(info.llm, true);
    const chatA = (
      await app.inject({ method: "POST", url: "/api/ai/chat", payload: { question: "Проверь лицензию Bar Studio" } })
    ).json();
    assert.deepEqual([chatA.intent, chatA.eula.name], ["eula", "Bar Studio"]);
  } finally {
    config.openaiBaseUrl = saved;
    await app.close();
    srv.close();
  }
});

test("правила понимают русские формулировки (в JS \\w не совпадает с кириллицей — окончания слов через [а-яё])", () => {
  assert.equal(
    analyzeByRules("Программа предоставляется только для некоммерческого использования.").commercial_use,
    "forbidden",
  );
  assert.equal(analyzeByRules("Разрешено некоммерческое использование программы.").commercial_use, "forbidden");
  assert.equal(analyzeByRules("Пробная версия действует 30 дней.").license_kind, "trial");
  assert.equal(analyzeByRules("Бесплатная программа для всех пользователей.").license_kind, "freeware");
  assert.equal(
    analyzeByRules("Настоящее лицензионное соглашение заключается между правообладателем и пользователем.")
      .license_kind,
    "commercial",
  );
});
