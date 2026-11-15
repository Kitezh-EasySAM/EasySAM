/**
 * Продукты хранилища ключей и маскировка ключей (наружу — только 5 последних символов). Тесты:
 * test/licensePool.test.ts, test/security.test.ts
 */
/**
 * Продукты хранилища ключей (application с ПК = product в хранилище; совпадение ключа — по 5 последним символам).
 *  deploy: агент умеет ставить ключ этого продукта (задание set_license). Остальные — только учёт: места, сроки,
 *  «ключ на большем числе ПК, чем мест». Новый продукт = строка здесь (+ поддержка в агенте для раздачи).
 */
export interface ProductDef {
  title: string;
  installNames: string[];
  deploy: boolean;
  keyHint: string;
  keyPlaceholder: string;
}
export const PRODUCTS: Record<string, ProductDef> = {
  cryptopro_csp: {
    title: "КриптоПро CSP",
    installNames: ["криптопро csp", "cryptopro csp"],
    deploy: true,
    keyHint: "серийный номер (25 символов); агент ставит его на ПК",
    keyPlaceholder: "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX",
  },
  kaspersky_kes: {
    title: "Kaspersky Endpoint Security",
    installNames: ["kaspersky endpoint security"],
    deploy: false,
    keyHint:
      "ID лицензии из avp.com LICENSE /CHECK или KSC (по нему считаются занятые места); ставить ключ — через KSC",
    keyPlaceholder: "3084-000789-456AB78C",
  },
  nanocad: {
    title: "nanoCAD",
    installNames: ["nanocad"],
    deploy: false,
    keyHint: "серийный номер; с ПК приходит его окончание из имени файла .lic",
    keyPlaceholder: "NCP80-XXXXXXXXXXXX-XXXXX",
  },
  "1c_enterprise": {
    title: "1С:Предприятие",
    installNames: ["1c:предприятие", "1с:предприятие"],
    deploy: false,
    keyHint: "номер программной лицензии (имя файла .lic в ProgramData\\1C\\licenses)",
    keyPlaceholder: "8100000000000-000000000",
  },
  drweb: {
    title: "Dr.Web",
    installNames: ["dr.web"],
    deploy: false,
    keyHint: "номер ключа (Number в ключевом файле .key)",
    keyPlaceholder: "0123456789",
  },
};

/** Для формы «Новый ключ»: продукты, можно ли раздавать, подсказка к ключу. */
export const productList = () =>
  Object.entries(PRODUCTS).map(([product, p]) => ({
    product,
    title: p.title,
    can_deploy: p.deploy,
    key_hint: p.keyHint,
    key_placeholder: p.keyPlaceholder,
  }));

/**
 * Скрыть ключи лицензий в произвольном тексте (вывод cpconfig от агента, ошибки): XXXXX-XXXXX-…-ABCDE →
 *   •••••-•••••-…-ABCDE.
 * С ПК наружу — только 5 последних символов.
 */
export const maskKeys = (text: string) =>
  text.replace(/(?<![0-9A-Za-z])[0-9A-Za-z]{5}(?:-[0-9A-Za-z]{5}){3,5}(?![0-9A-Za-z])/g, (k) =>
    k
      .split("-")
      .map((g, i, a) => (i === a.length - 1 ? g : "•••••"))
      .join("-"),
  );

/** Последние 5 символов ключа (буквы и цифры, верхний регистр) — для сверки с partial_key с ПК. */
export const keyTail = (key: string) =>
  key
    .replace(/[^0-9A-Za-z]/g, "")
    .slice(-5)
    .toUpperCase();
/** Ключ для показа: все группы, кроме последней, заменены точками. */
export const maskKey = (key: string) => {
  const parts = key.split("-");
  return parts.length > 1
    ? [...parts.slice(0, -1).map((p) => "•".repeat(p.length)), parts.at(-1)].join("-")
    : `•••••${keyTail(key)}`;
};
