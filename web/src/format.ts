import type { LicenseKind } from "./api/types.ts";
/** Вид лицензии (license_kind) для людей — одно место для всех экранов. */
export const KIND_LABEL: Record<LicenseKind, string> = {
  commercial: "Коммерческая",
  freeware: "Бесплатная (freeware)",
  shareware: "Условно-бесплатная",
  open_source: "Open source",
  trial: "Пробная",
};
export const kindLabel = (k?: string | null) => (k ? (KIND_LABEL[k as LicenseKind] ?? k) : "");

export const num = (n: number | null | undefined) =>
  n == null ? "" : n.toLocaleString("ru-RU").replace(/\u00A0/g, " ");
export const rub = (n: number) => `${num(n)} ₽`;

const utc = (s: string) => new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");

export function relTime(s: string | null): string {
  if (!s) return "нет данных";
  const min = Math.floor((Date.now() - utc(s).getTime()) / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  if (min < 60 * 24) return `${Math.floor(min / 60)} ч назад`;
  const d = Math.floor(min / 1440);
  if (d === 1) return "вчера, " + utc(s).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  return `${d} дн назад`;
}
export const hhmm = (s: string) => utc(s).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
export const dateRu = (s: string | null) =>
  s ? utc(s.length === 10 ? s + " 00:00:00" : s).toLocaleDateString("ru-RU") : "—";

/** Статус агента считает сервер по последнему контакту именно агента (agent_last_seen); no_agent — ПК только из загрузки файла. */
export type Presence = "online" | "offline" | "lost" | "no_agent";
export const presence = (d: { agent_status?: Presence | null }): Presence => d.agent_status ?? "no_agent";
export const PRESENCE_LABEL: Record<Presence, string> = {
  online: "В сети",
  offline: "Не в сети",
  lost: "Нет связи",
  no_agent: "Нет агента",
};
export const PRESENCE_TONE = { online: "green", offline: undefined, lost: "amber", no_agent: undefined } as const;

export function downloadCsv(name: string, rows: (string | number | null)[][]) {
  // защита от формул в Excel: значение с =, +, -, @ (имя программы с ПК может быть любым) — с апострофом
  const esc = (v: string | number | null) => {
    const s = typeof v === "number" ? String(v) : String(v ?? "").replace(/^([=+\-@\t\r])/, "'$1");
    return `"${s.replace(/"/g, '""')}"`;
  };
  const text = "﻿" + rows.map((r) => r.map(esc).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const STATUS_LABEL = { forbidden: "Запрещено", outdated: "Устарело", current: "Актуально" } as const;
export const COMPLIANCE_LABEL = {
  forbidden: "Запрещено",
  over: "Не хватает лицензий",
  outdated: "Устарело",
  idle: "Простой",
  ok: "В норме",
} as const;

/** Адрес чата с готовым запросом «добавить программу»: value — название или ссылка на программу / текст лицензии. */
export const aiAddHref = (value: string) => {
  const v = value.trim();
  return `/assistant?q=${encodeURIComponent(/^https?:\/\//i.test(v) ? v : `Добавь в одобренное ПО: ${v}`)}`;
};

/** Сравнение строк по кодам символов — порядок как у `sort()` без аргумента (даты ISO сортируются верно). */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Подпись «ассистент думает»: первые 3 с — без счётчика, дальше секунды; после 20 с — честно, что модель медленная. */
export const thinkingLabel = (sec: number): string =>
  sec < 3 ? "Думаю" : sec < 20 ? `Думаю · ${sec} с` : `Модель думает дольше обычного · ${sec} с`;
