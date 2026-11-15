import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { applySnapshot } from "../src/services/ingest.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;
/** Данные SSE-сообщения: поля, которые проверяют тесты (остальные — как есть). */
type StreamData = Row & { raw_name?: string; alert?: { reason: string; text: string } };

/** Подключается к /api/stream и собирает сообщения; parse SSE-блоков. */
async function listen(base: string, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal, headers });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const msgs: { id?: string; event: string; data: StreamData }[] = [];
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const f: Record<string, string> = {};
          for (const line of block.split("\n")) {
            const m = line.match(/^(\w+): (.*)$/);
            if (m) f[m[1]] = m[2];
          }
          if (f.event) msgs.push({ id: f.id, event: f.event, data: JSON.parse(f.data) });
        }
      }
    } catch {
      /* abort */
    }
  })();
  const waitFor = async (pred: (m: (typeof msgs)[number]) => boolean, ms = 3000) => {
    const t0 = Date.now();
    for (;;) {
      const m = msgs.find(pred);
      if (m) return m;
      if (Date.now() - t0 > ms)
        throw new Error("не дождался сообщения; есть: " + JSON.stringify(msgs.map((x) => x.event)));
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { msgs, waitFor, close: () => ctrl.abort() };
}

async function setup() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO software_catalog (id, name, license_kind, internal_status) VALUES
    (1, 'WinRAR', 'shareware', 'forbidden'), (2, 'Microsoft Office', 'commercial', 'current'), (3, '7-Zip', 'open_source', 'current');
    INSERT INTO license_purchase (catalog_id, seats) VALUES (2, 1);
    INSERT INTO employee (id, full_name) VALUES (1, 'Иванов Иван');`);
  applySnapshot(db, { serial_number: "A", hostname: "WS-1", items: [{ name: "Microsoft Office" }] });
  applySnapshot(db, { serial_number: "B", hostname: "WS-2", items: [{ name: "7-Zip" }] });
  db.exec("UPDATE device SET employee_id = 1 WHERE serial_number = 'B'");
  const app = await buildApp(db);
  const base = await app.listen({ port: 0, host: "127.0.0.1" });
  const post = (url: string, body: unknown, token = true) =>
    fetch(`${base}${url}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...(token ? { "x-ingest-token": "dev-token" } : {}) },
    });
  return { db, app, base, post };
}

test("SSE: алерт о запрещённом ПО и о превышении лицензий приходит сразу", async () => {
  const { app, base, post } = await setup();
  const s = await listen(base);
  await post("/api/ingest/events", {
    serial_number: "B",
    events: [
      { type: "installed", name: "WinRAR 4.00 (64-bit)", new_version: "4.00" },
      { type: "installed", name: "Microsoft Office", new_version: "16" }, // 2 ПК при 1 месте
      { type: "installed", name: "Microsoft Visual C++ 2015 Redistributable" }, // шум: сообщения нет
    ],
  });
  const win = await s.waitFor((m) => m.event === "install" && !!m.data.raw_name?.startsWith("WinRAR"));
  assert.equal(win.data.alert?.reason, "forbidden");
  assert.match(String(win.data.alert?.text), /WinRAR.*WS-2.*Иванов Иван/);
  assert.ok(Number(win.id) > 0);
  const off = await s.waitFor((m) => m.event === "install" && m.data.raw_name === "Microsoft Office");
  assert.equal(off.data.alert?.reason, "over_license");
  assert.match(String(off.data.alert?.text), /2 ПК при 1/);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.msgs.filter((m) => m.event === "install").length, 2);
  s.close();
  await app.close();
});

test("SSE: итоги загрузки (агент и CSV), changed после CRUD, без алерта для обычного ПО", async () => {
  const { app, base, post } = await setup();
  const s = await listen(base);
  await post("/api/ingest/agent", { serial_number: "B", items: [{ name: "7-Zip" }, { name: "Google Chrome" }] });
  const ing = await s.waitFor((m) => m.event === "ingest" && m.data.source === "agent");
  assert.equal(ing.data.events, 1);
  const chrome = await s.waitFor((m) => m.event === "install" && m.data.raw_name === "Google Chrome");
  assert.equal(chrome.data.alert, null);

  const fd = new FormData();
  fd.append("file", new Blob(["SERIAL_NUMBER;DISPLAYNAME\nC;7-Zip\n"]), "x.csv");
  await fetch(`${base}/api/ingest/csv`, { method: "POST", body: fd });
  assert.equal((await s.waitFor((m) => m.event === "ingest" && m.data.source === "csv")).data.devices, 1);

  await post("/api/catalog", { name: "Новое ПО" }, false);
  assert.deepEqual((await s.waitFor((m) => m.event === "changed")).data, { method: "POST", path: "/api/catalog" });
  s.close();
  await app.close();
});

test("SSE: Last-Event-ID досылает пропущенное после переподключения", async () => {
  const { app, base, post } = await setup();
  // клиент получил событие 7-Zip, отвалился, пока ставили WinRAR и Chrome, переподключился с Last-Event-ID
  const first = await listen(base);
  await post("/api/ingest/events", { serial_number: "A", events: [{ type: "installed", name: "7-Zip" }] });
  const seen = await first.waitFor((m) => m.data.raw_name === "7-Zip");
  first.close();
  await post("/api/ingest/events", {
    serial_number: "A",
    events: [
      { type: "installed", name: "WinRAR" },
      { type: "installed", name: "Google Chrome" },
    ],
  });
  const s = await listen(base, { "Last-Event-ID": seen.id! });
  await s.waitFor((m) => m.data.raw_name === "Google Chrome");
  assert.deepEqual(
    s.msgs.filter((m) => m.event === "install").map((m) => m.data.raw_name),
    ["WinRAR", "Google Chrome"],
  );
  s.close();
  await app.close();
});
