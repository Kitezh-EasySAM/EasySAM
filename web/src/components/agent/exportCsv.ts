import type { EventRow, PcLicense, ProcessRow, Software } from "../../api/types.ts";
import { dateRu, downloadCsv, kindLabel } from "../../format.ts";
import { APP_LABEL, EVENT_LABEL, LIC_STATUS_LABEL, RISK_LABEL, SW_LABEL, swState } from "./labels.ts";

type TabRows =
  | { tab: "software"; rows: Software[] }
  | { tab: "licenses"; rows: PcLicense[] }
  | { tab: "processes"; rows: ProcessRow[] }
  | { tab: "events"; rows: EventRow[] };

/** CSV текущей вкладки карточки ПК (те же строки, что на экране, с учётом поиска и фильтров). */
export function exportTab(host: string, t: TabRows) {
  if (t.tab === "software")
    downloadCsv(`${host}-software.csv`, [
      [
        "Название",
        "Каталог",
        "Издатель",
        "Версия",
        "Нужная версия",
        "Соответствие",
        "Лицензия",
        "Сопоставление",
        "Статус",
      ],
      ...t.rows.map((x) => [
        x.raw_name,
        x.catalog_name,
        x.raw_publisher,
        x.raw_version,
        x.min_version,
        x.version_match === "older"
          ? "ниже нужной"
          : x.version_match === "newer"
            ? "новее нужной"
            : (x.version_match ?? ""),
        kindLabel(x.license_kind),
        x.match_method,
        SW_LABEL[swState(x)],
      ]),
    ]);
  else if (t.tab === "licenses")
    downloadCsv(`${host}-licenses.csv`, [
      ["Приложение", "Продукт", "Канал", "Ключ", "Статус", "Действует до", "Риски", "Собрано"],
      ...t.rows.map((x) => [
        APP_LABEL[x.application] ?? x.application,
        x.product,
        x.channel,
        x.partial_key,
        LIC_STATUS_LABEL[x.status] ?? x.status,
        dateRu(x.expires_at),
        x.risks.map((r) => RISK_LABEL[r] ?? r).join(", "),
        x.collected_at,
      ]),
    ]);
  else if (t.tab === "processes")
    downloadCsv(`${host}-processes.csv`, [
      ["Программа", "Издатель", "Версия", "Путь", "Сопоставление", "Переносное", "Последний запуск"],
      ...t.rows.map((x) => [
        x.product_name ?? x.exe_name,
        x.company,
        x.file_version,
        x.exe_path,
        x.catalog_name ?? x.installation_name ?? "",
        x.portable ? "да" : "",
        x.last_seen,
      ]),
    ]);
  else
    downloadCsv(`${host}-events.csv`, [
      ["Время (UTC)", "Тип", "Программа", "Издатель", "Было", "Стало"],
      ...t.rows.map((e) => [e.at, EVENT_LABEL[e.type], e.raw_name, e.raw_publisher, e.old_version, e.new_version]),
    ]);
}
