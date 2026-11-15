/** Шаблоны .xlsx для импорта (шапка + строка-пример). GET /api/import/templates/:kind. Тесты: test/assistant.test.ts */
import ExcelJS from "exceljs";
import type { ImportKind } from "./importer.ts";
/** Шаблон .xlsx: шапка + строка-пример. */
export async function template(kind: ImportKind): Promise<Buffer> {
  const t: Record<ImportKind, { cols: string[]; example: (string | number)[]; widths: number[] }> = {
    employees: {
      cols: ["ФИО", "Отдел", "Активен", "ПК (серийный номер)"],
      example: ["Иванов Иван Иванович", "Бухгалтерия", "да", "B1RG0S2"],
      widths: [32, 22, 10, 26],
    },
    catalog: {
      cols: [
        "Наименование",
        "Вендор",
        "Назначение",
        "Тип лицензии",
        "Лицензионное соглашение",
        "Статус",
        "Мин. версия",
        "Реестр РФ",
        "Цена",
      ],
      example: [
        "КОМПАС-3D",
        "АСКОН",
        "САПР",
        "коммерческая",
        "Лицензионный договор АСКОН",
        "актуальный",
        "21",
        "да",
        60000,
      ],
      widths: [28, 18, 24, 16, 30, 14, 12, 10, 12],
    },
    purchases: {
      cols: ["ПО", "Мест", "Цена", "Действует до", "Договор"],
      example: ["Microsoft Office", 100, 15000, "31.12.2027", "Д-2025/118"],
      widths: [28, 8, 12, 14, 16],
    },
  };
  const s = t[kind];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Импорт");
  ws.addRow(s.cols).font = { bold: true };
  ws.addRow(s.example);
  s.widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
