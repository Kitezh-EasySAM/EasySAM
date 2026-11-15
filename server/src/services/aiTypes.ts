/**
 * Общее для ассистента: формат ответа чата, примеры вопросов, форматирование чисел и дат в ответах правил.
 * Используют: ai.ts (вход), aiRules.ts, aiFind.ts, aiStarters.ts, aiLlm.ts. Тесты: test/assistant.test.ts
 */
import type { EulaAnalysis } from "./eula.ts";

export interface ChatTable {
  columns: string[];
  rows: (string | number | null)[][];
}
export interface ChatAnswer {
  answer: string;
  intent: string;
  source: "rules" | "llm" | "none";
  eula?: EulaAnalysis; // проверка лицензии: фронт показывает карточку с кнопкой «Добавить в одобренное ПО»
  table?: ChatTable;
  sql?: string;
  links?: { label: string; href: string }[];
  suggestions?: string[];
}

export const EXAMPLES = [
  "У скольких человек установлен Photoshop?",
  "У кого стоит WinRAR?",
  "Какие лицензии можно перенести и куда?",
  "Чего не хватает по лицензиям?",
  "Что истекает в ближайший месяц?",
  "Какие лицензии простаивают?",
  "Что установлено у Соколовой?",
  "Сколько ПК в сети?",
  "Проверь лицензию 7-Zip",
  "Можно ли использовать TeamViewer?",
];

/** Числа по-русски с обычным неразрывным пробелом (toLocaleString даёт узкий U+202F). */
export const n = (x: number) =>
  Math.round(x)
    .toLocaleString("ru-RU")
    .replace(/\u202f/g, "\u00a0");
/** «1 место», «3 места», «5 мест». */
export const places = (k: number) =>
  `${n(k)} ${k % 10 === 1 && k % 100 !== 11 ? "место" : k % 10 >= 2 && k % 10 <= 4 && (k % 100 < 12 || k % 100 > 14) ? "места" : "мест"}`;
/** Дата YYYY-MM-DD… → ДД.ММ.ГГГГ; null → «—». */
export const fmtDate = (s: string | null) => (s ? s.slice(0, 10).split("-").reverse().join(".") : "—");
/** Сколько полных дней прошло с даты SQLite (UTC); null — даты нет. */
export const daysAgo = (s: string | null) =>
  s ? Math.floor((Date.now() - Date.parse(s.replace(" ", "T") + "Z")) / 86_400_000) : null;
/** «сегодня», «N дн. назад» или «нет данных». */
export const lastRun = (s: string | null) => {
  const d = daysAgo(s);
  return d == null ? "нет данных" : d === 0 ? "сегодня" : `${d} дн. назад`;
};
