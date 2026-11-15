/**
 * Обрезка символов по краям строки без регулярных выражений.
 * Замена шаблонам вида `/[…]+$/`: движок пробует их с каждой позиции, и на длинной строке это квадратично.
 */

/** Срезать с конца символы из `chars`. */
export function trimEndChars(s: string, chars: string): string {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1])) end--;
  return s.slice(0, end);
}

/** Срезать с начала символы из `chars`. */
export function trimStartChars(s: string, chars: string): string {
  let start = 0;
  while (start < s.length && chars.includes(s[start])) start++;
  return s.slice(start);
}

/** Срезать с обоих концов символы из `chars`. */
export const trimChars = (s: string, chars: string): string => trimEndChars(trimStartChars(s, chars), chars);

/** Пробельные символы для `trim*Chars` (то же, что `\s` в регулярных выражениях для обычного текста). */
export const SPACES = " \t\n\r\f\v   ﻿";

/** Сравнение строк по кодам символов — тот же порядок, что у `sort()` без аргумента, но явно и без локали. */
export const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
