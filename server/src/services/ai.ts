/**
 * ИИ-ассистент: вопросы на русском о парке ПО и лицензиях → ответ + таблица.
 *  1) Правила (работают без ключа и без интернета): «у скольких / у кого установлен X», «что можно перенести»,
 *     «что истекает», «чего не хватает», «что простаивает», «запрещённое», «неопознанное», «что стоит у <ФИО|ПК>»,
 *   «сколько ПК».
 *     Название программы ищется нечётко (опечатки, транслит: «хром» ≈ Chrome, «криптопро» ≈ CryptoPro).
 *  2) Если правила не поняли и задан OPENAI_API_KEY (или OPENAI_BASE_URL локальной модели) — text-to-SQL:
 *     модель пишет ОДИН SELECT по белому списку таблиц, сервер проверяет его, выполняет с PRAGMA query_only и LIMIT,
 *     модель кратко пересказывает результат. SQL возвращается пользователю. Секретные таблицы (ключи, токены)
 *   недоступны.
 * Тесты: test/assistant.test.ts, test/security.test.ts
 */
import type { DB } from "../db.ts";
import { answerByRules } from "./aiRules.ts";
import { answerByLlm, llmEnabled } from "./aiLlm.ts";
import { EXAMPLES, type ChatAnswer } from "./aiTypes.ts";
import { SPACES, trimEndChars, trimStartChars } from "./text.ts";

// прежние имена — для роутов и тестов: логика разнесена по aiRules / aiFind / aiLlm / aiStarters / aiTypes
export { answerByRules } from "./aiRules.ts";
export { findProgram } from "./aiFind.ts";
export { guardSql, llm, LlmBusy, llmEnabled, llmInfo, parseJsonReply, stripThink } from "./aiLlm.ts";
export { starters, type Starter } from "./aiStarters.ts";
export { EXAMPLES, type ChatAnswer, type ChatTable } from "./aiTypes.ts";

/** Вопрос про лицензию конкретной программы или ссылка → цель проверки EULA (null — не про это). */
export function eulaTarget(q: string): string | null {
  const url = /(https?:\/\/\S+)/i.exec(q)?.[1];
  if (url) return trimEndChars(url, `).,;»"'`);
  if (q.length > 400) return /licen[cs]e|лицензи|соглашени|eula/i.test(q) ? q : null; // вставили текст лицензии
  const s = q.trim();
  // Триггер ищем регулярным выражением, а хвост разбираем кодом: одна регулярка на всё была квадратичной.
  for (const m of s.matchAll(EULA_TRIGGER)) {
    const name = eulaName(s.slice(m.index + m[0].length));
    if (name) return name;
  }
  return null;
}

const EULA_TRIGGER =
  /eula|проверь\s+(?:лицензию|eula)|какая\s+лицензия\s+у|лицензия\s+у|можно\s+ли\s+(?:использовать|ставить|установить)|одобрить|добавь\s+в\s+одобренн[а-яё]*/gi;
const EULA_FILLER = /^(?:программы|программу|по(?![а-яёa-z]))/i;

/** Название после триггера: без «программу/по», двоеточия и кавычек; null — пусто или название с переносом строки. */
function eulaName(rest: string): string | null {
  let s = trimStartChars(rest, SPACES);
  const filler = EULA_FILLER.exec(s)?.[0];
  if (filler && unquote(s.slice(filler.length))) s = s.slice(filler.length);
  return unquote(s) || null;
}
const unquote = (s: string): string => {
  let t = trimStartChars(s, SPACES);
  if (t.length > 1 && ':«"'.includes(t[0])) t = trimStartChars(t.slice(1), SPACES);
  if (/[\n\r\u2028\u2029]/.test(t)) return "";
  return (trimEndChars(t, '»"?.!') || t.slice(0, 1)).trim();
};

/** Ответ ассистента: проверка лицензии, затем правила, затем модель (если подключена); не бросает исключений. */
export async function chat(db: DB, question: string): Promise<ChatAnswer> {
  const target = eulaTarget(question);
  if (target) {
    const { analyzeEula } = await import("./eula.ts");
    try {
      const e = await analyzeEula(db, target);
      return {
        answer: `${e.name ?? "Программа"}: ${e.verdict_text.toLowerCase()}. ${e.summary}`.trim(),
        intent: "eula",
        source: e.source,
        eula: e,
        ...(e.existing
          ? { links: [{ label: `Уже в каталоге: ${e.existing.name}`, href: `/catalog/${e.existing.id}` }] }
          : {}),
      };
    } catch (err) {
      return {
        answer: `Не удалось проверить лицензию: ${(err as Error).message}`,
        intent: "eula",
        source: "none",
        suggestions: ["Проверь лицензию 7-Zip", "Можно ли использовать TeamViewer?"],
      };
    }
  }
  const byRules = answerByRules(db, question);
  if (byRules) return byRules;
  if (llmEnabled()) {
    try {
      return await answerByLlm(db, question);
    } catch (e) {
      return {
        answer: `ИИ-модель недоступна (${(e as Error).message}). Попробуйте вопрос из примеров.`,
        intent: "llm",
        source: "none",
        suggestions: EXAMPLES,
      };
    }
  }
  return {
    answer: "Не понял вопрос. Без подключённой ИИ-модели я понимаю такие вопросы:",
    intent: "unknown",
    source: "none",
    suggestions: EXAMPLES,
  };
}
