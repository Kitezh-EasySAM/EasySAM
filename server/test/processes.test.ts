import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { applySnapshot } from "../src/services/ingest.ts";
import { applyUsage, matchProcess } from "../src/services/processes.ts";

/** Строка ответа API или SQLite: поля проверяются сравнением, тип значения не важен. */
type Row = Record<string, unknown>;

function setup() {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO software_catalog (id, name, license_kind, internal_status) VALUES
    (1, 'Microsoft Office', 'commercial', 'current'), (2, 'WinRAR', 'shareware', 'forbidden'),
    (3, 'Google Chrome', 'freeware', 'current'), (4, 'Oracle Java SE', 'commercial', 'current');
    INSERT INTO license_purchase (catalog_id, seats) VALUES (1, 10);`);
  applySnapshot(db, {
    serial_number: "PC",
    hostname: "WS-1",
    items: [
      { name: "Microsoft Office Standard 2016", install_location: "C:\\Program Files\\Microsoft Office\\" },
      { name: "Capture One", install_location: "C:\\Program Files\\Capture One\\" },
      { name: "Google Chrome" },
    ],
  });
  db.exec("UPDATE installation SET catalog_id = 1 WHERE raw_name LIKE 'Microsoft Office%'");
  return db;
}
const t = "2026-11-14T10:00:00Z";
const P = (o: object) =>
  ({ first_seen: t, last_seen: t, ...o }) as { exe: string; first_seen: string; last_seen: string };

test("сопоставление: путь установки, словарь exe (с проверкой издателя), ProductName, portable", () => {
  const db = setup();
  const m = (o: object) => matchProcess(db, "PC", P(o));
  assert.deepEqual(
    m({ exe: "WINWORD.EXE", path: "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE" }),
    { catalog_id: 1, installation_name: "Microsoft Office Standard 2016", method: "path", portable: false },
  );
  assert.deepEqual(m({ exe: "CaptureOne.exe", path: "c:/program files/capture one/CaptureOne.exe" }), {
    catalog_id: null,
    installation_name: "Capture One",
    method: "path",
    portable: false,
  });
  assert.deepEqual(
    m({ exe: "chrome.exe", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", company: "Google LLC" }),
    { catalog_id: 3, installation_name: null, method: "exe", portable: false },
  );
  assert.equal(
    m({ exe: "chrome.exe", company: "Evil Corp", path: "C:\\Users\\u\\Downloads\\chrome.exe" }).method,
    null,
    "чужой chrome.exe",
  );
  assert.equal(m({ exe: "java.exe", company: "BellSoft" }).catalog_id, null, "Liberica ≠ Oracle Java");
  const rar = m({ exe: "WinRAR.exe", path: "C:\\Users\\u\\Downloads\\winrar-portable\\WinRAR.exe" });
  assert.deepEqual([rar.catalog_id, rar.method, rar.portable], [2, "exe", true]);
  const any = m({
    exe: "AnyDesk.exe",
    path: "C:\\Users\\u\\Downloads\\AnyDesk.exe",
    product_name: "AnyDesk",
    company: "AnyDesk Software GmbH",
  });
  assert.deepEqual([any.catalog_id, any.portable], [null, true]);
  assert.equal(
    m({ exe: "app.exe", path: "C:\\Program Files\\Some\\app.exe" }).portable,
    false,
    "Program Files — не portable",
  );
  assert.equal(m({ exe: "x.exe", product_name: "Google Chrome" }).method, "installed", "Chrome установлен на этом ПК");
  // OneDrive: «для пользователя», без InstallLocation, exe в AppData — связь по ProductName, не portable (с реальной ВМ)
  db.exec(
    "INSERT INTO installation (device_serial, raw_name, norm_name) VALUES ('PC', 'Microsoft OneDrive', 'microsoft onedrive')",
  );
  assert.deepEqual(
    m({
      exe: "OneDrive.exe",
      path: "C:\\Users\\user\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe",
      product_name: "Microsoft OneDrive",
    }),
    { catalog_id: null, installation_name: "Microsoft OneDrive", method: "installed", portable: false },
  );
  // установщики из Загрузок — не «неустановленное ПО» (с реальной ВМ: systeminformer-…-release-setup.exe)
  for (const exe of ["systeminformer-4.0.26241.138-release-setup.exe", "setup.exe", "unins000.exe", "ChromeSetup.exe"])
    assert.deepEqual([exe, m({ exe, path: `C:\\Users\\u\\Downloads\\${exe}` }).method], [exe, "installer"]);
  assert.equal(
    m({ exe: "tool.exe", path: "C:\\Users\\u\\Downloads\\tool.exe", product_name: "System Informer - Setup" }).method,
    "installer",
  );
  assert.notEqual(
    m({ exe: "Insta360Studio.exe", path: "C:\\Users\\u\\Downloads\\Insta360Studio.exe" }).method,
    "installer",
    "не путать с «install» внутри слова",
  );
});

test("отчёт агента: last_used обновляется, алерты только на новое, агрегат накапливается", () => {
  const db = setup();
  const word = P({
    exe: "WINWORD.EXE",
    path: "C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE",
    samples: 3,
  });
  const rar = P({ exe: "WinRAR.exe", path: "C:\\Users\\u\\Downloads\\WinRAR.exe" });
  const r1 = applyUsage(db, "PC", [word, rar]);
  assert.deepEqual(
    r1.alerts.map((a) => [a.reason, a.level]),
    [["forbidden_running", "red"]],
  );
  assert.match(r1.alerts[0].text, /Запущено запрещённое ПО «WinRAR» \(WinRAR\.exe\) на WS-1/);
  assert.equal(
    (db.prepare("SELECT last_used FROM installation WHERE catalog_id = 1").get() as { last_used: string }).last_used,
    "2026-11-14 10:00:00",
  );

  const later = "2026-11-14T10:20:00Z";
  const r2 = applyUsage(db, "PC", [
    { ...word, last_seen: later },
    { ...rar, last_seen: later },
  ]);
  assert.equal(r2.alerts.length, 0, "тот же сеанс (< 1 ч) — без повторного алерта");
  const row = db
    .prepare("SELECT first_seen, last_seen, samples FROM process_usage WHERE exe_name = 'WINWORD.EXE'")
    .get() as Row;
  assert.deepEqual([row.first_seen, row.last_seen, row.samples], ["2026-11-14 10:00:00", "2026-11-14 10:20:00", 6]);

  const r3 = applyUsage(db, "PC", [
    P({ exe: "qbittorrent.exe", path: "C:\\Users\\u\\Downloads\\qbittorrent.exe", product_name: "qBittorrent" }),
  ]);
  assert.deepEqual(
    r3.alerts.map((a) => a.reason),
    ["portable"],
  );
  const sys = applyUsage(db, "PC", [
    P({ exe: "svchost.exe", path: "C:\\Windows\\System32\\svchost.exe" }),
    P({ exe: "lsass.exe" }),
    P({ exe: "svchost.exe" }),
  ]);
  assert.deepEqual(
    [
      sys.alerts.length,
      (db.prepare("SELECT COUNT(*) c FROM process_usage WHERE exe_name = 'svchost.exe'").get() as { c: number }).c,
    ],
    [0, 0],
  );
  assert.match(r3.alerts[0].text, /неустановленное ПО «qBittorrent» из C:\\Users\\u\\Downloads/);
});

test("пересчёт истории: строка, сохранённая по старым правилам, исправляется при старте", async () => {
  const db = setup();
  applyUsage(db, "PC", [P({ exe: "ChromeSetup.exe", path: "C:\\Users\\u\\Downloads\\ChromeSetup.exe" })]);
  db.exec("UPDATE process_usage SET match_method = NULL, portable = 1"); // как было до правила об установщиках
  const app = await buildApp(db);
  const row = db.prepare("SELECT match_method, portable FROM process_usage").get() as {
    match_method: string;
    portable: number;
  };
  assert.deepEqual([row.match_method, row.portable], ["installer", 0]);
  await app.close();
});

test("API: токен, 409 для неизвестного ПК, список процессов и фильтры, процессы в карточке ПК", async () => {
  const db = setup();
  const app = await buildApp(db);
  const send = (serial: string, token = "dev-token") =>
    app.inject({
      method: "POST",
      url: "/api/ingest/usage",
      headers: { "x-ingest-token": token },
      payload: {
        serial_number: serial,
        processes: [
          P({ exe: "WinRAR.exe", path: "C:\\Users\\u\\Downloads\\WinRAR.exe" }),
          P({ exe: "chrome.exe", company: "Google LLC" }),
        ],
      },
    });
  assert.equal((await send("PC", "bad")).statusCode, 401);
  assert.equal((await send("NOPE")).statusCode, 409);
  assert.deepEqual((await send("PC")).json(), { accepted: 2, alerts: 1 });
  const all = (await app.inject({ url: "/api/processes" })).json();
  assert.deepEqual([all.summary.total, all.summary.portable, all.summary.forbidden_running], [2, 1, 1]);
  assert.equal((await app.inject({ url: "/api/processes?filter=forbidden" })).json().items[0].exe_name, "WinRAR.exe");
  assert.equal((await app.inject({ url: "/api/devices/PC" })).json().processes.length, 2);
  await app.close();
});
