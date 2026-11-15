import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { parseDelimited, toDevices, UploadError } from "../src/services/tabular.ts";

test("CSV: разделители, кавычки, BOM, <Null>", () => {
  const t =
    "﻿COMPUTERS.SERIAL_NUMBER;SOFTWARE.DISPLAYNAME;SOFTWARE.PUBLISHER;SOFTWARE.VERSION\r\n" +
    'A1;"7-Zip; ""x64""";Igor Pavlov;19.00\r\nA1;Chrome;<Null>;<Null>\nB2;"Multi\nline";;1\n\n';
  const rows = parseDelimited(t);
  assert.equal(rows.length, 4);
  assert.equal(rows[1][1], '7-Zip; "x64"');
  const { devices, rowsInFile } = toDevices(rows);
  assert.equal(rowsInFile, 3);
  assert.deepEqual(
    devices.map((d) => [d.serial_number, d.items.length]),
    [
      ["A1", 2],
      ["B2", 1],
    ],
  );
  assert.equal(devices[0].items[1].publisher, null);
  assert.equal(devices[0].items[1].version, null);
});

test("CSV: запятая и tab определяются автоматически, шапка без префиксов", () => {
  for (const d of [",", "\t"]) {
    const { devices } = toDevices(parseDelimited(`serial_number${d}name${d}version\nS1${d}Git${d}2.4\n`));
    assert.equal(devices[0].items[0].name, "Git");
  }
});

test("CSV: нет обязательных колонок → понятная ошибка", () => {
  assert.throws(
    () => toDevices(parseDelimited("a;b\n1;2\n")),
    (e) => e instanceof UploadError && /SERIAL_NUMBER/.test(e.message),
  );
  assert.throws(() => toDevices(parseDelimited("SERIAL_NUMBER;DISPLAYNAME\n")), UploadError);
});

function multipart(filename: string, content: string) {
  const b = "----t" + Math.random().toString(16).slice(2);
  const body = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${content}\r\n--${b}--\r\n`;
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${b}` } };
}

test("API: загрузка CSV = один batch, повтор идемпотентен, второй файл даёт события, батчи в истории", async () => {
  const db = openDb(":memory:");
  db.exec("INSERT INTO software_catalog (id, name, license_kind) VALUES (1, '7-Zip', 'open_source')");
  const app = await buildApp(db);
  const csv1 =
    "SERIAL_NUMBER;DISPLAYNAME;PUBLISHER;VERSION\nA1;7-Zip 19.00 (x64 edition);Igor Pavlov;19.00\nA1;Microsoft Visual C++ 2013 Redistributable (x64);Microsoft;12.0\nB2;Mystery Tool;<Null>;1.0\n";
  const up = (name: string, c: string) => app.inject({ method: "POST", url: "/api/ingest/csv", ...multipart(name, c) });

  const r1 = (await up("hosts.csv", csv1)).json();
  assert.deepEqual(
    [r1.rows_in_file, r1.rows_total, r1.rows_noise, r1.rows_matched, r1.rows_unknown, r1.devices, r1.events],
    [3, 3, 1, 1, 1, 2, 0],
  );

  const r2 = (await up("hosts.csv", csv1)).json(); // идемпотентно
  assert.deepEqual([r2.rows_total, r2.events], [3, 0]);
  assert.equal((db.prepare("SELECT COUNT(*) c FROM installation").get() as { c: number }).c, 3);

  const r3 = (await up("hosts.csv", "SERIAL_NUMBER;DISPLAYNAME\nA1;Chrome\n")).json(); // A1: -7zip, +chrome (удаление VC++ — шум, не событие)
  assert.equal(r3.events, 2);

  const batches = (await app.inject({ url: "/api/ingest/batches" })).json();
  assert.equal(batches.length, 3);
  assert.equal(batches[0].source, "csv");

  const bad = await up("x.csv", "foo;bar\n1;2\n");
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /колонки/);
  assert.equal((await up("x.pdf", "a")).statusCode, 400);
  assert.equal((await app.inject({ method: "POST", url: "/api/ingest/csv" })).statusCode, 406); // не multipart
  await app.close();
});
