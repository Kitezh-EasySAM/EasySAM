import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildApp } from "../src/app.ts";
import { openDb } from "../src/db.ts";
import { hasMaterials } from "../src/scripts/materials.ts";
import { seed } from "../src/scripts/seed.ts";
import { highlights, managementData } from "../src/services/reports.ts";

const KEY = /[0-9A-Z]{5}(?:-[0-9A-Z]{5}){4}/;

test(
  "отчёты: выгрузка агентов в Excel, отчёт для руководства в Excel и PDF; без полных ключей",
  { skip: !hasMaterials() },
  async () => {
    const db = openDb(":memory:");
    await (seed as (d: unknown) => unknown)(db);
    const app = await buildApp(db);
    try {
      const agents = await app.inject({ url: "/api/export/agents.xlsx" });
      assert.equal(agents.statusCode, 200);
      assert.match(
        String(agents.headers["content-disposition"]),
        /attachment; filename="easysam-agents-\d{4}-\d{2}-\d{2}\.xlsx"/,
      );
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(agents.rawPayload as unknown as ArrayBuffer);
      assert.deepEqual(
        wb.worksheets.map((w) => w.name),
        ["Рабочие места", "Установленное ПО", "Лицензии ПК"],
      );
      const devices = (db.prepare("SELECT COUNT(*) c FROM device").get() as { c: number }).c;
      assert.equal(wb.getWorksheet("Рабочие места")!.rowCount, devices + 1, "все агенты + шапка");
      assert.equal(wb.getWorksheet("Рабочие места")!.getRow(1).getCell(2).value, "Имя ПК");
      assert.equal(
        KEY.test(JSON.stringify(wb.worksheets.map((w) => w.getSheetValues()))),
        false,
        "полных ключей в выгрузке нет",
      );

      const rep = await app.inject({ url: "/api/reports/management.xlsx" });
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.load(rep.rawPayload as unknown as ArrayBuffer);
      assert.ok(
        ["Сводка", "Не хватает лицензий", "Запрещённое ПО", "Договоры"].every((n) => wb2.getWorksheet(n)),
        wb2.worksheets.map((w) => w.name).join(),
      );

      const pdf = await app.inject({ url: "/api/reports/management.pdf" });
      assert.equal(pdf.headers["content-type"], "application/pdf");
      assert.equal(pdf.rawPayload.subarray(0, 5).toString(), "%PDF-");
      const pages = (pdf.rawPayload.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
      assert.ok(pages >= 1 && pages <= 6, `страниц: ${pages} (без пустых)`);
    } finally {
      await app.close();
    }
  },
);

test("отчёт: показатели и главные выводы считаются из данных", () => {
  const db = openDb(":memory:");
  db.exec(`INSERT INTO software_catalog (id, name, license_kind, internal_status) VALUES (1, 'Офис', 'commercial', 'current'), (2, 'Архиватор', 'shareware', 'forbidden');
    INSERT INTO license_purchase (catalog_id, seats) VALUES (1, 1);
    INSERT INTO device (serial_number, hostname) VALUES ('A', 'PC-A'), ('B', 'PC-B');
    INSERT INTO installation (device_serial, raw_name, norm_name, catalog_id, is_noise) VALUES ('A', 'Офис', 'офис', 1, 0), ('B', 'Офис', 'офис', 1, 0), ('B', 'Архиватор', 'архиватор', 2, 0);`);
  const m = managementData(db);
  assert.deepEqual(
    [m.kpi.devices, m.kpi.missing_seats, m.kpi.forbidden_pcs, m.forbiddenPcs[0].hostname],
    [2, 1, 1, "PC-B"],
  );
  const h = highlights(m).join(" ");
  assert.match(h, /Не хватает 1 лицензий по 1 программам: больше всего — Офис \(установлено на 2 ПК, куплено 1\)/);
  assert.match(h, /Запрещённое ПО найдено на 1 ПК \(Архиватор\)/);
});
