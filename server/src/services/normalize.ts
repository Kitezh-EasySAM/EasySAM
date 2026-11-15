import { trimChars } from "./text.ts";

/**
 * Чистка «грязных» данных агента: детектор шума, нормализация имён/издателей, версии.
 * Чистые функции без БД. Тесты: test/normalize.test.ts.
 * Правила шума подобраны по реальной выгрузке: ~60% строк — компоненты, а не продукты.
 * Менять правила → `make noise-report` и смотреть долю шума и то, что просочилось.
 * ВАЖНО: в JS `\b` не работает с кириллицей — используем lookaround (см. WB_L/WB_R).
 */

const NOISE_PATTERNS: string[] = [
  String.raw`\bredistributable\b`,
  String.raw`visual c\+\+ .*(runtime|crt|headers)`,
  String.raw`\b(additional|minimum) runtime\b`,
  String.raw`^(security )?update for\b`,
  String.raw`^hotfix\b`,
  String.raw`\bKB\d{5,}\b`,
  String.raw`\blanguage pack\b`,
  String.raw`\bproof(ing)? ?(tools)?\b.*\b(20\d\d|\()`,
  String.raw`средства проверки правописания`,
  String.raw`\bmicrosoft \.net (framework|runtime|core)\b`,
  String.raw`\b(driver|firmware)\b`,
  String.raw`^intel\(r\) `,
  String.raw`^realtek `,
  String.raw`\bnative client\b`,
  String.raw`\bdata-tier application framework\b`,
  String.raw`tools for office runtime`,
  String.raw`^microsoft policy platform$`,
  String.raw`^dhtml editing component$`,
  String.raw`^windows live `,
  String.raw`\bMUI\b`,
  String.raw`korrekturhilfen|засоби перевірки|языковой пакет|языковые пакеты`,
  String.raw`^intel[®(]|\bintel-sa-\d+|\bchipset\b`,
  String.raw`microsoft office (osm|shared|proof)`,
  String.raw`office \d* ?(64-bit )?components|primary interop assemblies`,
  String.raw`service pack \d|\(sp\d\)`,
  String.raw`visio (viewer|compatibility)|compatibility pack`,
  String.raw`autodesk material library|autocad .*(vba|enabler|language|support)|photoshop camera raw|photoshop specific|cs4 support`,
  String.raw`^java (auto updater|device manager)`,
  // современный .NET/WinUI: среды выполнения, а не программы (на ВМ с Windows 10: Desktop Runtime, ASP.NET Core
  // Runtime)
  String.raw`desktop runtime|asp\.net core|\.net (core )?(runtime|sdk)|windows app runtime|webview2 runtime`,
  String.raw`^microsoft update health tools$|^update for windows\b`,
];
const NOISE_RE = new RegExp(NOISE_PATTERNS.map((p) => `(?:${p})`).join("|"), "i");

const ARCH_PAREN = /\((?:x64|x86|64[- ]?bit|32[- ]?bit|amd64)[^)]*\)/gi;
const ARCH_WORD = /\b(?:x64|x86|amd64|64[- ]?bit|32[- ]?bit)\b/gi;
const VERSION = /\bv?\d+(?:\.\d+)+\b/g;
const EXT = /\.(?:exe|msi|dmg|deb|rpm)\b/gi;
const SETUP = /\b(?:setup|installer|install)\b/gi;

const WB_L = String.raw`(?<![\p{L}\p{N}_])`;
const WB_R = String.raw`(?![\p{L}\p{N}_])`;
const PUBLISHER_SUFFIX = new RegExp(
  `${WB_L}(?:corporation|corp|incorporated|inc|ltd|llc|gmbh|co|company|systems|ао|ооо|пао|компания|лаборатория)${WB_R}\\.?`,
  "giu",
);
const PUBLISHER_ALIASES: [RegExp, string][] = [
  [/^microsoft/, "microsoft"],
  [/^sap\b/, "sap"],
  [/kaspersky|касперск/, "kaspersky"],
  [/^adobe/, "adobe"],
  [/^oracle/, "oracle"],
];
const NULLS = new Set(["", "<null>", "null", "none", "n/a"]);

/** Служебный компонент (обновление, библиотека, драйвер, языковой пакет), а не программа. */
export function isNoise(name: string): boolean {
  return NOISE_RE.test(name ?? "");
}

/** '7-Zip 19.00 (x64 edition)' -> '7-zip'; 'studio_visual_2022.exe' -> 'studio visual 2022' */
export function normalizeName(raw: string): string {
  let s = (raw ?? "").trim();
  s = s.replace(EXT, "").replaceAll("_", " ");
  s = s.replace(ARCH_PAREN, " ").replace(ARCH_WORD, " ").replace(VERSION, " ").replace(SETUP, " ");
  s = s.replace(/[^\p{L}\p{N}_+#.\- ]/gu, " ");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Издатель без юридической формы и с единым именем крупных вендоров; пусто — издателя нет. */
export function normalizePublisher(raw?: string | null): string {
  let s = trimChars((raw ?? "").trim(), '"«»').toLowerCase();
  if (NULLS.has(s)) return "";
  s = s
    .replace(/[,."«»]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, canon] of PUBLISHER_ALIASES) if (re.test(s)) return canon;
  return s.replace(PUBLISHER_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

/** '8.0.2010.9' -> [8,0,2010,9]; мусор/пусто -> [] */
export function versionTuple(v?: string | null): number[] {
  if (!v || NULLS.has(v.trim().toLowerCase())) return [];
  return (v.match(/\d+/g) ?? []).slice(0, 4).map(Number);
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Устарел, если версия известна и строго ниже minVersion. Неизвестная версия не считается устаревшей. */
export function isOutdated(version?: string | null, minVersion?: string | null): boolean {
  const have = versionTuple(version),
    need = versionTuple(minVersion);
  return have.length > 0 && need.length > 0 && cmp(have, need) < 0;
}

/**
 * Соответствие нужной версии каталога: 'ok' (совпадает), 'older' (ниже нужной — устарело) или 'newer' (обновилось
 *   сверх одобренной).
 * Сравниваем с той точностью, с которой задана нужная версия: «16.0» — это вся ветка 16.0.x (16.0.4266.1001 → ok),
 * «8» — Java 8 любого обновления; точный билд задаётся целиком («16.0.4266.1001»). 17.1 при «16.0» — newer, 14.0 —
 *   older.
 * null — сравнивать нечего: нет нужной версии, версии установки или позиции в каталоге.
 */
export function versionMatch(version?: string | null, minVersion?: string | null): "older" | "newer" | "ok" | null {
  const have = versionTuple(version),
    need = versionTuple(minVersion);
  if (!have.length || !need.length) return null;
  const d = cmp(have.slice(0, need.length), need);
  return d < 0 ? "older" : d > 0 ? "newer" : "ok";
}
