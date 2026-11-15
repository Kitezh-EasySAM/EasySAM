/**
 * Нечёткое сопоставление нормализованных имён с каталогом (шаг «fuzzy» в каскаде матчинга).
 * Чистые функции. Кандидаты = имена каталога + все известные алиасы (они несут много вариантов написания).
 * Оценка 0..1 = максимум из:
 *   - похожести строк с отсортированными токенами (Левенштейн), ловит опечатки и перестановки слов;
 *   - «вложенности»: все токены кандидата есть в имени (DIRECTUM ⊂ «directum rapid waiter»).
 * Бонус за совпадение издателя. Пороги откалиброваны на реальной выгрузке.
 * Тесты: test/unmatched.test.ts
 */
import { normalizePublisher } from "./normalize.ts";
import { byCodeUnit } from "./text.ts";

export interface Candidate {
  catalogId: number;
  catalogName: string;
  norm: string;
  vendor: string;
}
export interface Suggestion {
  catalog_id: number;
  name: string;
  score: number;
  method: "fuzzy";
}

const tokens = (s: string) => s.split(/[\s-]+/).filter((t) => t.length > 0);

/** Расстояние Левенштейна между строками (число правок). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Похожесть строк 0..1 по Левенштейну. */
export function ratio(a: string, b: string): number {
  const m = Math.max(a.length, b.length);
  return m ? 1 - levenshtein(a, b) / m : 1;
}

const TR: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};
/** Латиница + фонетическое упрощение: «криптопро» и «cryptopro» → «kriptopro». */
export function phonetic(s: string): string {
  const lat = [...s].map((ch) => TR[ch] ?? ch).join("");
  return lat
    .replace(/ph/g, "f")
    .replace(/c(?!h)/g, "k")
    .replace(/y/g, "i")
    .replace(/w/g, "v");
}

/** Похожесть двух нормализованных имён, 0..1 (с учётом транслитерации: «CryptoPro CSP» ≈ «КриптоПро CSP»). */
export function similarity(name: string, cand: string): number {
  const direct = rawSimilarity(name, cand);
  if (direct >= 1 || !/[а-яё]/.test(name + cand)) return direct;
  return Math.max(direct, rawSimilarity(phonetic(name), phonetic(cand)));
}

function rawSimilarity(name: string, cand: string): number {
  const nt = tokens(name),
    ct = tokens(cand);
  if (!nt.length || !ct.length) return 0;
  const seq = ratio([...nt].sort(byCodeUnit).join(" "), [...ct].sort(byCodeUnit).join(" "));
  // вложенность: значимые токены кандидата (≥2 символов) все присутствуют в имени
  const sig = ct.filter((t) => t.length >= 2);
  const nset = new Set(nt);
  const contained = sig.length > 0 && sig.every((t) => nset.has(t));
  const coverage = sig.join("").length / Math.max(1, nt.join("").length);
  const cont = contained ? 0.8 + 0.15 * Math.min(1, coverage) : 0;
  return Math.max(seq, cont);
}

/** Топ-k подсказок по каталогу (дубли каталога схлопываются, берётся лучший кандидат). */
// Порог 0.72: ниже на реальных данных шёл мусор по общему слову-вендору («microsoft silverlight» → Visio 0.62,
// «windows 7» → Office 0.70); выше — полезные родственники (DIRECTUM-компоненты 0.88+, плагины Kaspersky 0.9+).
export const MIN_SUGGEST_SCORE = 0.72;

/** До k подсказок каталога для нормализованного имени (score ≥ minScore), лучшие первыми. */
export function suggest(
  norm: string,
  publisher: string | null,
  cands: Candidate[],
  k = 3,
  minScore = MIN_SUGGEST_SCORE,
): Suggestion[] {
  const pub = normalizePublisher(publisher);
  const best = new Map<number, Suggestion>();
  for (const c of cands) {
    let s = similarity(norm, c.norm);
    if (s <= 0) continue;
    if (pub && c.vendor && (pub === c.vendor || pub.includes(c.vendor) || c.vendor.includes(pub)))
      s = Math.min(1, s + 0.05);
    const prev = best.get(c.catalogId);
    if (!prev || s > prev.score)
      best.set(c.catalogId, {
        catalog_id: c.catalogId,
        name: c.catalogName,
        score: Math.round(s * 100) / 100,
        method: "fuzzy",
      });
  }
  return [...best.values()]
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
