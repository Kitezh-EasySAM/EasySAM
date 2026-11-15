/**
 * Правила логина, ФИО и пароля — ЗЕРКАЛО server/src/services/users.ts (сервер проверяет сам; здесь — для подсказок на лету).
 * Меняешь правило — меняй в обоих местах.
 */
const RESERVED_LOGINS = new Set(["root", "system", "administrator", "guest", "test", "user", "support", "sam"]);
const COMMON = [
  "password",
  "passw0rd",
  "qwerty",
  "qwertyuiop",
  "letmein",
  "welcome",
  "admin",
  "administrator",
  "iloveyou",
  "monkey",
  "dragon",
  "football",
  "пароль",
  "йцукен",
  "привет",
  "sam",
  "surgut",
  "сургут",
  "123456",
  "1234567890",
  "abc123",
];

/** Срезать «i» в конце (без регулярного выражения `/i+$/` — оно квадратично на длинной строке). */
const trimEndI = (s: string) => {
  let end = s.length;
  while (end > 0 && s[end - 1] === "i") end--;
  return s.slice(0, end);
};

/** Ошибка формата логина (null — подходит): латиница в нижнем регистре, 3–32 символа, с буквы, без «..», «.-» на конце. */
export function loginProblem(login: string): string | null {
  const l = login.trim();
  if (!/^[a-z][a-z0-9._-]{2,31}$/.test(l))
    return "логин: 3–32 символа, латиница в нижнем регистре, цифры, «.», «-», «_», начинается с буквы";
  if (/[._-]{2}/.test(l) || /[._-]$/.test(l)) return "логин: знаки «.», «-», «_» не подряд и не в конце";
  if (RESERVED_LOGINS.has(l)) return `логин «${l}» зарезервирован`;
  return null;
}

/** ФИО: минимум два слова из букв (дефис и апостроф допустимы). */
export function nameProblem(name: string | null | undefined): string | null {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return "укажите фамилию и имя";
  if (!words.every((w) => /^[\p{L}][\p{L}'’-]*$/u.test(w))) return "ФИО: только буквы, дефис и апостроф";
  return null;
}

const SEQS = [
  "abcdefghijklmnopqrstuvwxyz",
  "абвгдеёжзийклмнопрстуфхцчшщъыьэюя",
  "0123456789",
  "qwertyuiop",
  "asdfghjkl",
  "zxcvbnm",
  "йцукенгшщзхъ",
  "фывапролджэ",
  "ячсмитьбю",
];
const hasSequence = (p: string) => {
  const s = p.toLowerCase();
  for (const seq of SEQS)
    for (const src of [seq, [...seq].reverse().join("")])
      for (let i = 0; i + 4 <= src.length; i++) if (s.includes(src.slice(i, i + 4))) return true;
  return false;
};

/** Все нарушения правил пароля (пусто — пароль подходит). login и name — чтобы пароль их не содержал. */
export function passwordProblems(p: string, ctx: { login?: string | null; name?: string | null } = {}): string[] {
  const out: string[] = [];
  if (p.length < 10) out.push("не короче 10 символов");
  if (p.length > 128) out.push("не длиннее 128 символов");
  if (!/\p{Ll}/u.test(p)) out.push("строчная буква");
  if (!/\p{Lu}/u.test(p)) out.push("заглавная буква");
  if (!/\d/.test(p)) out.push("цифра");
  if (!/[^\p{L}\d]/u.test(p)) out.push("спецсимвол (например ! # - _ ?)");
  if (/(.)\1\1/u.test(p)) out.push("без трёх одинаковых символов подряд");
  if (hasSequence(p)) out.push("без последовательностей вроде 1234, abcd, qwer");
  const low = p.toLowerCase();
  // логин целиком и по частям (petrova.a → petrova), слова ФИО
  const parts = [ctx.login, ...(ctx.login ?? "").split(/[._-]/), ...(ctx.name ?? "").split(/\s+/)]
    .filter((x): x is string => !!x && x.length >= 3)
    .map((x) => x.toLowerCase());
  if (parts.some((x) => low.includes(x))) out.push("не содержит логин и ФИО");
  // «P@ssw0rd!» = «password»: замены букв цифрами/знаками не спасают
  const LEET: Record<string, string> = {
    "@": "a",
    "4": "a",
    "0": "o",
    "1": "i",
    "!": "i",
    "3": "e",
    $: "s",
    "5": "s",
    "7": "t",
  };
  const deleet = low.replace(/[@401!3$57]/g, (c) => LEET[c]).replace(/[^\p{L}]/gu, "");
  const core = low.replace(/[^\p{L}]/gu, "");
  if (COMMON.some((w) => core === w || deleet === w || trimEndI(deleet) === w || low.replace(/[^\p{L}\d]/gu, "") === w))
    out.push("не из списка распространённых паролей");
  return out;
}

/** Случайный пароль, проходящий правила: 16 символов, все классы, без похожих символов (0/O, 1/l/I). */
export function randomPassword(): string {
  const groups = ["abcdefghjkmnpqrstuvwxyz", "ABCDEFGHJKLMNPQRSTUVWXYZ", "23456789", "!#%+-_=?@"];
  const all = groups.join("");
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const chars = groups.map((g, i) => g[bytes[i] % g.length]);
    for (let i = groups.length; chars.length < 16; i++) chars.push(all[bytes[i] % all.length]);
    for (let i = chars.length - 1; i > 0; i--) {
      const j = bytes[16 + i] % (i + 1);
      [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    const pw = chars.join("");
    if (!passwordProblems(pw).length) return pw;
  }
}

/** Все правила списком — для подсказки с галочками в форме. */
export const PASSWORD_RULES = [
  "не короче 10 символов",
  "строчная буква",
  "заглавная буква",
  "цифра",
  "спецсимвол (например ! # - _ ?)",
  "без трёх одинаковых символов подряд",
  "без последовательностей вроде 1234, abcd, qwer",
  "не содержит логин и ФИО",
  "не из списка распространённых паролей",
];

/** Оценка 0–4 для полоски надёжности. */
export function passwordScore(p: string, ctx: { login?: string | null; name?: string | null } = {}): number {
  if (!p) return 0;
  const problems = passwordProblems(p, ctx).length;
  if (problems) return problems > 3 ? 1 : 2;
  return p.length >= 14 ? 4 : 3;
}
