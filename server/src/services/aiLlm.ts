/**
 * Клиент ИИ-модели (OpenAI-совместимый API: OpenAI, LM Studio, Ollama) и text-to-SQL: модель пишет один SELECT,
 * guardSql проверяет его по белому списку таблиц, sqlWorker выполняет только на чтение с LIMIT и таймаутом.
 * Результат запроса в модель не уходит (там могут быть ФИО). Тесты: test/assistant.test.ts, test/security.test.ts
 */
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { EXAMPLES, type ChatAnswer, type ChatTable } from "./aiTypes.ts";
import { runReadOnly } from "./sqlWorker.ts";
import { SPACES, trimEndChars, trimStartChars } from "./text.ts";

// ---------------- LLM: text-to-SQL (только при заданном ключе / локальной модели)

const ALLOWED_TABLES = [
  "device",
  "employee",
  "software_catalog",
  "license_type",
  "license_purchase",
  "installation",
  "install_event",
  "device_license",
  "process_usage",
  "ingest_batch",
  "alias",
];
const SCHEMA_HINT = `SQLite. Таблицы (только они):
device(serial_number PK, hostname, os, employee_id, last_seen, agent_last_seen)
employee(id, full_name, department, active 0/1)
software_catalog(id, name, vendor, purpose, registry_section, registry_class, internal_status current|outdated|forbidden, min_version, license_kind open_source|freeware|shareware|trial|commercial, in_ru_registry, list_price)
license_type(id, name, kind, commercial_use, copyleft)
license_purchase(id, catalog_id, seats, unit_price, valid_until YYYY-MM-DD или NULL, contract)
installation(id, device_serial, raw_name, raw_publisher, raw_version, norm_name, is_noise 0/1, catalog_id, last_used, install_location)
install_event(id, device_serial, type installed|removed|updated, raw_name, old_version, new_version, catalog_id, at)
device_license(id, device_serial, application windows|office|cryptopro_csp|kaspersky_kes|nanocad|1c_enterprise|drweb, product, channel, partial_key, status licensed|grace|notification|unlicensed|trial|expired, expires_at)
process_usage(id, device_serial, exe_name, exe_path, product_name, company, catalog_id, portable 0/1, first_seen, last_seen, samples)
Правила: установки считай по DISTINCT device_serial и is_noise = 0; даты — строки 'YYYY-MM-DD HH:MM:SS' UTC; поиск по названиям и отделам — LIKE по lower(...) (lower понимает кириллицу); отдел ИТ пиши как lower(department) LIKE '%ит%'.`;

const CLOSED_TABLES = [
  "license_pool",
  "agent_token",
  "enroll_key",
  "agent_command",
  "app_user",
  "user_session",
  "sqlite_master",
  "sqlite_schema",
];

/** Проверка SQL от модели: один SELECT/WITH, без опасных слов, только разрешённые таблицы; добавляет LIMIT. */
export function guardSql(sql: string, extraClosed: string[] = []): string {
  const s = trimEndChars(sql.trim(), `;${SPACES}`);
  if (!/^(select|with)\b/i.test(s)) throw new Error("разрешён только SELECT");
  if (s.includes(";")) throw new Error("разрешён один запрос");
  if (
    /\b(insert|update|delete|drop|alter|attach|detach|pragma|create|replace|vacuum|reindex|load_extension)\b/i.test(s)
  )
    throw new Error("запрещённая операция");
  // закрытые таблицы — по любому упоминанию (не только после FROM/JOIN: «FROM a, license_pool», подзапросы)
  const closed = [...new Set([...CLOSED_TABLES, ...extraClosed])];
  const hit = closed.find((t) => new RegExp(`\\b${t}\\b`, "i").test(s));
  if (hit) throw new Error(`таблица недоступна: ${hit}`);
  if (/\bsqlite_\w+|\bpragma_\w+/i.test(s)) throw new Error("служебные таблицы недоступны");
  const used = [...s.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase());
  const ctes = new Set([...s.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const bad = used.filter((t) => !ALLOWED_TABLES.includes(t) && !ctes.has(t));
  if (bad.length) throw new Error(`недоступная таблица: ${bad[0]}`);
  return `SELECT * FROM (${s}) LIMIT 200`; // всегда — даже если модель написала LIMIT 1000000
}

const isLocalLlm = () => !!config.openaiBaseUrl && !/api\.openai\.com/.test(config.openaiBaseUrl);

/** Имя модели и провайдер — для экрана ассистента. */
export function llmInfo() {
  if (!llmEnabled()) return { provider: null, model: null };
  const provider = !config.openaiBaseUrl
    ? "OpenAI"
    : /:1234\b/.test(config.openaiBaseUrl)
      ? "LM Studio"
      : /11434/.test(config.openaiBaseUrl)
        ? "Ollama"
        : isLocalLlm()
          ? "локальная модель"
          : "OpenAI";
  return { provider, model: config.llmModel };
}

/**
 * Запрос к OpenAI-совместимому API (OpenAI, LM Studio, Ollama). Для локальных моделей рассуждения выключены
 * (reasoning_effort: none — у Qwen 3.5 ответ за секунды вместо минут); JSON просим текстом — LM Studio не знает
 *   json_object.
 */
export class LlmBusy extends Error {}
let llmActive = 0;

/**
 * Запрос к модели; LlmBusy — если уже идёт llmMaxConcurrent запросов, Error — модель недоступна или ответила
 * ошибкой.
 */
export async function llm(
  messages: { role: string; content: string }[],
  json: boolean,
  maxTokens = 1200,
): Promise<string> {
  // локальная модель обрабатывает запросы по одному: очередь из десятков запросов повесила бы ответы всем
  if (llmActive >= config.llmMaxConcurrent)
    throw new LlmBusy("ИИ-модель занята другими запросами — повторите через минуту");
  llmActive++;
  try {
    return await llmCall(messages, json, maxTokens);
  } finally {
    llmActive--;
  }
}

async function llmCall(
  messages: { role: string; content: string }[],
  json: boolean,
  maxTokens: number,
): Promise<string> {
  const base = (config.openaiBaseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
  const local = isLocalLlm();
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.openaiApiKey ? { authorization: `Bearer ${config.openaiApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.llmModel,
      messages,
      temperature: 0,
      max_tokens: maxTokens,
      ...(local
        ? { reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } }
        : json
          ? { response_format: { type: "json_object" } }
          : {}),
    }),
    signal: AbortSignal.timeout(config.llmTimeoutMs),
  });
  if (!r.ok) throw new Error(`модель ответила ${r.status}`);
  const d = (await r.json()) as { choices?: { message?: { content?: string } }[] };
  return stripThink(d.choices?.[0]?.message?.content ?? "");
}

/** Убрать рассуждения <think>…</think>, если модель их всё же прислала. */
export const stripThink = (s: string) =>
  s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*<\/think>/i, "")
    .trim();

/** Содержимое первого блока ```…``` (метка json срезается), без регулярного выражения. */
function fencedBlock(s: string): string | undefined {
  const open = s.indexOf("```");
  if (open === -1) return undefined;
  let from = open + 3;
  if (s.slice(from, from + 4).toLowerCase() === "json") from += 4;
  const close = s.indexOf("```", from);
  return close === -1 ? undefined : trimStartChars(s.slice(from, close), SPACES);
}

/** JSON из ответа модели: целиком, из ```json …```, или первый {...}. */
export function parseJsonReply<T>(raw: string): T {
  const s = stripThink(raw);
  const fenced = fencedBlock(s);
  for (const c of [s, fenced, s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)]) {
    if (!c) continue;
    try {
      return JSON.parse(c) as T;
    } catch {
      /* следующий вариант */
    }
  }
  throw new Error("модель вернула не JSON");
}

/** Подключена ли модель: задан ключ OpenAI или адрес совместимого сервера. */
export const llmEnabled = () => !!(config.openaiApiKey || config.openaiBaseUrl);

/** Text-to-SQL: модель пишет SELECT, сервер проверяет и выполняет только на чтение; ошибки — текстом в ответе. */
export async function answerByLlm(db: DB, question: string): Promise<ChatAnswer> {
  const raw = await llm(
    [
      {
        role: "system",
        content: `Ты аналитик учёта ПО. По вопросу пользователя напиши ОДИН запрос SQLite только на чтение. ${SCHEMA_HINT}\nОтветь JSON: {"sql": "...", "title": "короткое описание"}`,
      },
      { role: "user", content: question },
    ],
    true,
  );
  let sql: string;
  // всё, что есть в БД и не в белом списке, — закрыто (новые таблицы закрыты автоматически)
  const closed = (
    db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as { name: string }[]
  )
    .map((t) => t.name)
    .filter((t) => !ALLOWED_TABLES.includes(t));
  let title = "";
  try {
    const parsed = parseJsonReply<{ sql?: string; title?: string }>(raw);
    title = String(parsed.title ?? "").slice(0, 200);
    sql = guardSql(String(parsed.sql ?? ""), closed);
  } catch (e) {
    return {
      answer: `Не смог построить безопасный запрос: ${(e as Error).message}.`,
      intent: "llm",
      source: "llm",
      suggestions: EXAMPLES.slice(0, 4),
    };
  }
  let rows: Record<string, unknown>[];
  try {
    rows = await runReadOnly(db, sql, config.sqlTimeoutMs);
  } catch (e) {
    return { answer: `Запрос не выполнился: ${(e as Error).message}`, intent: "llm", source: "llm", sql };
  }
  const columns = rows[0] ? Object.keys(rows[0]) : [];
  const table: ChatTable = {
    columns,
    rows: rows.map((r) => columns.map((c) => (r[c] as string | number | null) ?? null)),
  };
  // результат в модель НЕ отправляем (там могут быть ФИО) — ответ собираем локально
  const single = rows.length === 1 && columns.length === 1 ? ` Ответ: ${String(table.rows[0][0])}.` : "";
  const answer = `${title ? `${title}. ` : ""}Найдено строк: ${rows.length}${rows.length >= 200 ? " (показаны первые 200)" : ""}.${single}`;
  return { answer, intent: "llm", source: "llm", sql, table };
}
