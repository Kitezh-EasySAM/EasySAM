import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isNoise,
  isOutdated,
  normalizeName,
  normalizePublisher,
  versionMatch,
  versionTuple,
} from "../src/services/normalize.ts";

test("шум распознаётся", () => {
  for (const n of [
    "Microsoft Visual C++ 2013 x86 Additional Runtime - 12.0.21005",
    "Microsoft Visual C++ 2005 Redistributable (x64)",
    "Security Update for Microsoft Office 2010 (KB2553332) 32-Bit Edition",
    "Update for Microsoft Office 2016 (KB4011225) 32-Bit Edition",
    "Microsoft Exchange Client Language Pack - Kannada",
    "Intel(R) Management Engine Components",
    "Microsoft Visual Studio 2010 Tools for Office Runtime (x64)",
    "Средства проверки правописания Microsoft Office 2013 — русский",
    "Microsoft Word MUI (Russian) 2016",
    "Microsoft Windows Desktop Runtime 10.0.7 (x64)",
    "Microsoft ASP.NET Core Runtime - 10.0.7 (x64)",
    "Microsoft Update Health Tools",
    "Microsoft Visual C++ 2015-2022 Redistributable (x64) - 14.42.34433",
  ])
    assert.ok(isNoise(n), n);
});

test("продукты не шум", () => {
  for (const n of [
    "Google Chrome",
    "7-Zip 19.00 (x64 edition)",
    "Java 8 Update 201",
    "WinRAR 4.00 (64-bit)",
    "Adobe Photoshop CS4 (64 Bit)",
    "Kaspersky Endpoint Security для Windows",
    "Microsoft Visio 2016",
    "Microsoft Office Standard 2016",
    "Capture One",
    "Microsoft Edge",
    "Microsoft OneDrive",
    "VMware Tools",
  ])
    assert.ok(!isNoise(n), n);
});

test("нормализация имён", () => {
  const cases: [string, string][] = [
    ["7-Zip 19.00 (x64 edition)", "7-zip"],
    ["studio_visual_2022.exe", "studio visual 2022"],
    ["chrome.exe", "chrome"],
    ["Google_Chrome_v2", "google chrome v2"],
    ["WinRAR 4.00 (64-bit)", "winrar"],
    ["Java 8 Update 201 (64-bit)", "java 8 update 201"],
    ["Клиентская часть системы DIRECTUM 5.5.1", "клиентская часть системы directum"],
  ];
  for (const [raw, exp] of cases) assert.equal(normalizeName(raw), exp, raw);
});

test("издатели схлопываются", () => {
  assert.equal(normalizePublisher("Microsoft Corporation"), "microsoft");
  assert.equal(normalizePublisher("Microsoft"), "microsoft");
  assert.equal(normalizePublisher("SAP SE"), "sap");
  assert.equal(normalizePublisher("SAP BusinessObjects"), "sap");
  assert.equal(normalizePublisher("<Null>"), "");
  assert.equal(normalizePublisher('АО "Лаборатория Касперского"'), "kaspersky");
  assert.equal(normalizePublisher("Igor Pavlov"), "igor pavlov");
});

test("версии", () => {
  assert.deepEqual(versionTuple("8.0.2010.9"), [8, 0, 2010, 9]);
  assert.deepEqual(versionTuple("<Null>"), []);
  assert.ok(isOutdated("7.0.60", "8.0"));
  assert.ok(!isOutdated("8.0.2010.9", "8.0"));
  assert.ok(!isOutdated(null, "8.0"));
});

test("versionMatch: нужная версия каталога", () => {
  assert.equal(versionMatch("16.0.4266.1001", "16.0.4266.1001"), "ok");
  assert.equal(versionMatch("16.0", "16.0.0.0"), "ok"); // короткая запись = та же версия
  assert.equal(versionMatch("14.0.7015.1000", "16.0"), "older"); // устарело
  assert.equal(versionMatch("17.1", "16.0"), "newer"); // обновилось сверх одобренной
  assert.equal(versionMatch("16.0.4266.1001", "16.0"), "ok"); // «16.0» = вся ветка 16.0.x
  assert.equal(versionMatch("16.0.4266.1001", "16.0.5000"), "older"); // нужен конкретный билд — сравниваем до билда
  assert.equal(versionMatch("16.0.4266.1001", "16.0.4266.1002"), "older");
  assert.equal(versionMatch("8.0.2010.9", "8"), "ok"); // Java 8 Update 201 при нужной «8»
  assert.equal(versionMatch("5.0.12000", "5.0"), "ok"); // КриптоПро 5.0
  assert.equal(versionMatch("5.1.1000", "5.0"), "newer");
  assert.equal(versionMatch(null, "16.0"), null); // версия установки неизвестна
  assert.equal(versionMatch("16.0", null), null); // нужная не задана
  assert.equal(versionMatch("16.0", "<Null>"), null);
});
