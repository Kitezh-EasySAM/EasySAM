// Подписи, цвета и порядок статусов для карточки ПК (вкладки и их таблицы).
import { STATUS_LABEL } from "../../format.ts";

export const swState = (s: {
  catalog_name: string | null;
  internal_status: string | null;
  version_match?: string | null;
}) => {
  if (!s.catalog_name) return "unknown";
  if (!s.internal_status || s.internal_status === "current") {
    if (s.version_match === "older") return "outdated";
    if (s.version_match === "newer") return "newer";
  }
  return s.internal_status ?? "current";
};
export const SW_LABEL: Record<string, string> = { ...STATUS_LABEL, unknown: "Нераспределённое", newer: "Новее нужной" };
export const SW_CLASS: Record<string, string> = {
  forbidden: "red",
  outdated: "amber",
  current: "green",
  unknown: "muted",
  newer: "amber",
};
export const SW_ORDER: Record<string, number> = { forbidden: 0, outdated: 1, newer: 2, unknown: 3, current: 4 };
export const VERSION_TITLE = { older: "версия ниже нужной", newer: "приложение обновилось сверх нужной" } as const;
export const EVENT_LABEL = { installed: "Установлено", updated: "Обновлено", removed: "Удалено" } as const;
export const EVENT_TONE = { installed: "green", updated: "blue", removed: undefined } as const;

export const SW_METHOD: Record<string, string> = {
  exact: "точное имя",
  alias: "по названию",
  manual: "вручную",
  fuzzy: "похожее имя",
  ai: "ИИ",
};
export const APP_LABEL: Record<string, string> = {
  windows: "Windows",
  office: "Office",
  cryptopro_csp: "КриптоПро CSP",
  kaspersky_kes: "Kaspersky Endpoint Security",
  nanocad: "nanoCAD",
  "1c_enterprise": "1С:Предприятие",
  drweb: "Dr.Web",
};
export const LIC_STATUS_LABEL: Record<string, string> = {
  licensed: "Активировано",
  grace: "Льготный период",
  notification: "Требует активации",
  unlicensed: "Не активировано",
  unknown: "Неизвестно",
  trial: "Пробная",
  expired: "Истекла",
};
export const LIC_STATUS_TONE: Record<string, "green" | "amber" | "red" | undefined> = {
  licensed: "green",
  grace: "amber",
  notification: "amber",
  unlicensed: "red",
  unknown: undefined,
  trial: "amber",
  expired: "red",
};
export const RISK_LABEL: Record<string, string> = {
  unlicensed: "Не активировано",
  expired: "Истекла",
  key_reuse: "Ключ на нескольких ПК",
  expiring: "Истекает",
  grace: "Льготный период",
  trial: "Пробная",
};
export const METHOD_LABEL: Record<string, string> = {
  installer: "Установщик",
  path: "Папка установки",
  installed: "Установленная",
  exe: "Словарь exe",
  product: "ProductName",
  fuzzy: "Нечёткое",
};
export const LIC_ORDER: Record<string, number> = { red: 0, yellow: 1, green: 2 };
