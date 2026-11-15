/**
 * Smart Matching: ИИ-подсказки для «Неопознанного». Модель получает «грязные» названия с ПК и каталог и отвечает,
 * к какой позиции каталога относится каждое название — или что это компонент (не учитывать), или что не знает.
 *  - в модель уходят только названия ПО, издатели и каталог (данных о людях и ПК нет);
 *  - ответ — только ПОДСКАЗКА: привязку подтверждает человек (инвариант DATA_MODEL: привязка влияет на подсчёт
 *   лицензий);
 *  - catalog_id из ответа проверяется по каталогу — выдуманные позиции отбрасываются.
 * Контракт: docs/API.md §7. Тесты: test/unmatched.test.ts
 */
import type { DB } from "../db.ts";
import { llm, parseJsonReply } from "./aiLlm.ts";

export const AI_MATCH_MAX = 30;

export interface AiSuggestion {
  norm_name: string;
  verdict: "catalog" | "component" | "unknown";
  catalog_id: number | null;
  name: string | null; // позиция каталога (verdict = catalog)
  reason: string;
}

const PROMPT = `Ты помогаешь вести учёт программ в компании. Дан КАТАЛОГ (id: название — вендор) и список НАЗВАНИЙ,
собранных с компьютеров (возможны опечатки, версии, транслит, имена файлов). Для каждого названия реши:
 - "catalog" — это та же программа, что позиция каталога (укажи её id); другая редакция или другой продукт вендора — НЕ совпадение;
 - "component" — не самостоятельная программа: драйвер, плагин, библиотека, обновление, служебный компонент;
 - "unknown" — самостоятельная программа, которой в каталоге нет, или не уверен.
Ответь ТОЛЬКО JSON: {"items":[{"n": номер названия, "verdict": "catalog|component|unknown", "catalog_id": id или null, "why": "причина по-русски, до 12 слов"}]}`;

/** ИИ-подсказки для названий «Неопознанного» (по одной на имя, в том же порядке); Error — модель не ответила. */
export async function aiSuggest(db: DB, normNames: string[]): Promise<AiSuggestion[]> {
  const names = [...new Set(normNames)].slice(0, AI_MATCH_MAX);
  const catalog = db.prepare("SELECT id, name, vendor FROM software_catalog ORDER BY name").all() as {
    id: number;
    name: string;
    vendor: string | null;
  }[];
  const byId = new Map(catalog.map((c) => [c.id, c.name]));
  const info = db.prepare(
    "SELECT MIN(raw_name) AS raw, MAX(raw_publisher) AS publisher FROM installation WHERE norm_name = ? AND catalog_id IS NULL AND is_noise = 0",
  );
  const lines = names.map((nm, i) => {
    const r = info.get(nm) as { raw: string | null; publisher: string | null };
    return `${i + 1}. ${r.raw ?? nm}${r.publisher ? ` — издатель: ${r.publisher}` : ""}`;
  });
  const raw = await llm(
    [
      { role: "system", content: PROMPT },
      {
        role: "user",
        content: `КАТАЛОГ:\n${catalog.map((c) => `${c.id}: ${c.name}${c.vendor ? ` — ${c.vendor}` : ""}`).join("\n")}\n\nНАЗВАНИЯ:\n${lines.join("\n")}`,
      },
    ],
    true,
    2500,
  );
  const items = parseJsonReply<{ items?: unknown }>(raw).items;
  const out = new Map<string, AiSuggestion>();
  for (const it of Array.isArray(items) ? (items as Record<string, unknown>[]) : []) {
    const nm = names[Number(it?.n) - 1];
    if (!nm || out.has(nm)) continue;
    const id = Number(it.catalog_id);
    const reason = String(it.why ?? "").slice(0, 200);
    if (it.verdict === "catalog" && byId.has(id))
      out.set(nm, { norm_name: nm, verdict: "catalog", catalog_id: id, name: byId.get(id)!, reason });
    else if (it.verdict === "component")
      out.set(nm, { norm_name: nm, verdict: "component", catalog_id: null, name: null, reason });
    else out.set(nm, { norm_name: nm, verdict: "unknown", catalog_id: null, name: null, reason });
  }
  return names.map(
    (nm) => out.get(nm) ?? { norm_name: nm, verdict: "unknown", catalog_id: null, name: null, reason: "" },
  );
}
