/**
 * Разбор лицензии (EULA) по ссылке, названию программы или вставленному тексту → вывод и предложение
 * «добавить в одобренное ПО». Контракт: docs/API.md §19. Тесты: test/eula.test.ts
 *
 *  - ссылка: страница скачивается безопасно (safeFetch: только http/https, без адресов внутренней сети — проверка
 *    при каждом соединении, т.е. и после редиректа, и при подмене DNS; ≤2 МБ, 10 с), из HTML — текст; если на
 *   странице есть
 *    ссылка «License/EULA/Лицензия» — дочитываем и её;
 *  - название: справочник известных программ + знания модели (помечается «проверьте»);
 *  - текст: правила (MIT/GPL/Apache/…/«только для личного использования»/trial) + модель, если подключена.
 * В модель уходят только название и текст лицензии (данные о людях — нет).
 */
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { llm, llmEnabled, parseJsonReply } from "./aiLlm.ts";
import { KNOWN } from "./eulaKnown.ts";
import { analyzeByRules, LICENSES, verdictOf } from "./eulaRules.ts";
import { normalizeName } from "./normalize.ts";
import { FetchError, htmlToText, safeFetch } from "./safeFetch.ts";

// прежние имена — для роутов и тестов
export { approveSoftware, type ApproveInput } from "./eulaApprove.ts";
export { analyzeByRules } from "./eulaRules.ts";
export { FetchError, htmlToText, isPrivateAddress, safeFetch } from "./safeFetch.ts";

export type LicenseKind = "open_source" | "freeware" | "shareware" | "trial" | "commercial";
export type CommercialUse = "allowed" | "restricted" | "forbidden" | "unknown";
export type Verdict = "approve" | "review" | "reject";

export interface EulaAnalysis {
  input: string;
  input_kind: "url" | "name" | "text";
  name: string | null;
  vendor: string | null;
  version: string | null;
  license_name: string | null;
  license_kind: LicenseKind | null;
  commercial_use: CommercialUse;
  copyleft: boolean | null;
  subscription: boolean | null;
  seat_limit: string | null;
  audit_rights: boolean | null;
  summary: string;
  risks: { point: string; quote: string | null }[];
  verdict: Verdict;
  verdict_text: string;
  suggested_status: "current" | "forbidden";
  source: "llm" | "rules";
  sources: string[]; // откуда взят текст (адреса страниц)
  existing: { id: number; name: string; internal_status: string } | null;
  text_chars: number;
}

// ---------------- модель

const LLM_PROMPT = `Ты юрист по лицензиям ПО в российской компании. Проанализируй лицензию/описание программы.
Ответь ТОЛЬКО JSON без пояснений:
{"name": "название программы", "vendor": "правообладатель", "version": "версия или null",
 "license_name": "название лицензии (MIT, GPL v3, EULA ...)",
 "license_kind": "open_source|freeware|shareware|trial|commercial",
 "commercial_use": "allowed|restricted|forbidden|unknown",
 "copyleft": true|false|null, "subscription": true|false|null, "audit_rights": true|false|null,
 "seat_limit": "ограничение по пользователям/ПК или null",
 "summary": "2–3 предложения по-русски: можно ли использовать в организации и на каких условиях",
 "risks": [{"point": "риск по-русски", "quote": "короткая цитата из текста или null"}]}
commercial_use: allowed — можно в организации бесплатно или по купленным лицензиям; restricted — есть существенные ограничения (пробный срок, лимиты); forbidden — только личное/некоммерческое использование.`;

const KINDS = new Set(["open_source", "freeware", "shareware", "trial", "commercial"]);
const USES = new Set(["allowed", "restricted", "forbidden", "unknown"]);

async function analyzeByLlm(material: string, hint: string): Promise<Partial<EulaAnalysis> | null> {
  if (!llmEnabled()) return null;
  try {
    const raw = await llm(
      [
        { role: "system", content: LLM_PROMPT },
        { role: "user", content: `${hint}\n\n${material.slice(0, 12_000)}` },
      ],
      true,
      1500,
    );
    const j = parseJsonReply<Record<string, unknown>>(raw);
    const str = (v: unknown) =>
      typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim().slice(0, 300) : null;
    const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
    return {
      name: str(j.name),
      vendor: str(j.vendor),
      version: str(j.version),
      license_name: str(j.license_name),
      license_kind: KINDS.has(String(j.license_kind)) ? (j.license_kind as LicenseKind) : null,
      commercial_use: USES.has(String(j.commercial_use)) ? (j.commercial_use as CommercialUse) : "unknown",
      copyleft: bool(j.copyleft),
      subscription: bool(j.subscription),
      audit_rights: bool(j.audit_rights),
      seat_limit: str(j.seat_limit),
      summary: str(j.summary) ?? "",
      risks: Array.isArray(j.risks)
        ? j.risks
            .slice(0, 8)
            .map((r: { point?: unknown; quote?: unknown }) => ({
              point: String(r?.point ?? "").slice(0, 300),
              quote: str(r?.quote),
            }))
            .filter((r) => r.point)
        : [],
    };
  } catch {
    return null;
  } // модель недоступна/ответила мусором — остаёмся на правилах
}

// ---------------- главный вход

/** Похоже ли введённое на адрес страницы (с протоколом или без). */
export const looksLikeUrl = (s: string) =>
  /^(https?:\/\/|www\.)\S+$/i.test(s.trim()) ||
  (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s.trim()) && /\.(com|org|net|ru|io|de|info|app|dev|рф)(\/|$)/i.test(s.trim()));

/** Проверка лицензии по ссылке, названию или тексту; FetchError — страницу не удалось безопасно загрузить. */
export async function analyzeEula(
  db: DB,
  rawInput: string,
  fetcher: typeof safeFetch = safeFetch,
): Promise<EulaAnalysis> {
  const input = rawInput.trim().slice(0, 50_000);
  const kind: EulaAnalysis["input_kind"] = looksLikeUrl(input)
    ? "url"
    : input.length > 300 || input.includes("\n")
      ? "text"
      : "name";
  let material = kind === "text" ? input : "";
  let title = "";
  const sources: string[] = [];
  if (kind === "url") {
    if (!config.eulaFetch)
      throw new FetchError("загрузка страниц выключена (EULA_FETCH=off) — вставьте текст лицензии");
    const page = await fetcher(/^https?:/i.test(input) ? input : `https://${input}`);
    sources.push(page.url);
    const p = htmlToText(page.html, page.url);
    title = p.title;
    material = p.text;
    // страница программы, а не лицензии → дочитать ссылку «License/EULA»
    if (!LICENSES.some((l) => l.re.test(material)) && p.licenseLinks[0] && p.licenseLinks[0] !== page.url) {
      try {
        const lic = await fetcher(p.licenseLinks[0]);
        sources.push(lic.url);
        material = `${material.slice(0, 4000)}\n\n--- Лицензия (${lic.url}) ---\n${htmlToText(lic.html, lic.url).text}`;
      } catch {
        /* нет так нет */
      }
    }
  }
  const known = KNOWN.find((k) => k.re.test(kind === "name" ? input : `${title} ${input}`));
  const rules = analyzeByRules(material);
  const ai = await analyzeByLlm(
    kind === "name"
      ? `Программа: ${input}. Текста лицензии нет — опиши по своим знаниям, если не уверен — commercial_use: unknown.`
      : material,
    kind === "url"
      ? `Страница: ${sources.join(", ")} (заголовок: ${title})`
      : kind === "name"
        ? "Только название"
        : "Текст лицензии:",
  );

  const nameGuess = ai?.name ?? known?.name ?? (kind === "name" ? input : title.split(/[|–—:-]/)[0]?.trim() || null);
  const merged = {
    license_name: ai?.license_name ?? rules.license_name ?? known?.license ?? null,
    license_kind: ai?.license_kind ?? rules.license_kind ?? known?.kind ?? null,
    commercial_use:
      (ai?.commercial_use && ai.commercial_use !== "unknown"
        ? ai.commercial_use
        : rules.commercial_use !== "unknown"
          ? rules.commercial_use
          : known?.commercial) ?? "unknown",
    copyleft: rules.copyleft ?? ai?.copyleft ?? known?.copyleft ?? null, // распознанная лицензия (GPL/LGPL/MPL) точнее мнения модели
    subscription: ai?.subscription ?? rules.subscription,
    audit_rights: ai?.audit_rights ?? rules.audit_rights,
    risks: [
      ...(ai?.risks ?? []),
      ...rules.risks.filter((r) => !(ai?.risks ?? []).some((x) => x.point === r.point)),
    ].slice(0, 10),
  };
  // правило «только для личного использования» в тексте важнее мнения модели
  if (rules.commercial_use === "forbidden") merged.commercial_use = "forbidden";
  if (known?.note && !merged.risks.some((r) => r.point.includes(known.note!)))
    merged.risks.push({ point: known.note, quote: null });
  const v = verdictOf(merged);
  const name = nameGuess?.slice(0, 200) ?? null;
  const norm = name ? normalizeName(name) : "";
  const existing = name
    ? ((db
        .prepare("SELECT id, name, internal_status FROM software_catalog WHERE ulower(name) = ?")
        .get(name.toLowerCase()) as EulaAnalysis["existing"] | undefined) ??
      (norm
        ? (db
            .prepare(
              "SELECT c.id, c.name, c.internal_status FROM alias a JOIN software_catalog c ON c.id = a.catalog_id WHERE a.norm_name = ?",
            )
            .get(norm) as EulaAnalysis["existing"] | undefined)
        : undefined))
    : undefined;

  const summary =
    ai?.summary ||
    [
      merged.license_name && `Лицензия: ${merged.license_name}.`,
      v.text + ".",
      kind === "name" && !known ? "Текста лицензии не было — пришлите ссылку или текст для точного вывода." : "",
    ]
      .filter(Boolean)
      .join(" ");
  return {
    input: input.slice(0, 500),
    input_kind: kind,
    name,
    vendor: ai?.vendor ?? known?.vendor ?? null,
    version: ai?.version ?? null,
    ...merged,
    seat_limit: ai?.seat_limit ?? null,
    summary,
    verdict: v.verdict,
    verdict_text: v.text,
    suggested_status: v.verdict === "reject" ? "forbidden" : "current",
    source: ai ? "llm" : "rules",
    sources,
    existing: existing ?? null,
    text_chars: material.length,
  };
}
