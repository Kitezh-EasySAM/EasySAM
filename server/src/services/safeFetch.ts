/**
 * Безопасная загрузка страницы лицензии (защита от SSRF): только http/https, без логина в адресе, адреса внутренней
 * сети запрещены — проверка в момент каждого соединения (и после перенаправления, и при подмене DNS); ≤ 2 МБ, 10 с,
 * до 3 перенаправлений. Плюс HTML → текст. Используют: eula.ts. Тесты: test/eula.test.ts
 */
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export class FetchError extends Error {}

/** Адрес внутренней сети / локальный / служебный — туда сервер не ходит (защита от SSRF). */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const a = ip.toLowerCase();
    if (a === "::" || a === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)?.[1];
    if (mapped) return isPrivateAddress(mapped);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a) || a.startsWith("64:ff9b:") || a.startsWith("2001:db8");
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** DNS-поиск, который отказывает для внутренних адресов: проверка в момент соединения (нет окна для подмены DNS). */
function guardedLookup(
  hostname: string,
  options: object,
  cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const list = addrs as LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || !list.length) return cb(new FetchError("адрес во внутренней сети — загрузка запрещена"), "");
    if ((options as { all?: boolean }).all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

const MAX_BYTES = 2 * 1024 * 1024;

function getOnce(url: URL): Promise<{ status: number; location?: string; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    if (isIP(url.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, "")))
      return reject(new FetchError("адрес во внутренней сети — загрузка запрещена"));
    const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        method: "GET",
        lookup: guardedLookup as never,
        timeout: 10_000,
        headers: {
          "user-agent": "EasySAM-EULA-check/1.0",
          accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
          "accept-encoding": "identity",
        },
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, type: "", body: "" });
        }
        const type = String(res.headers["content-type"] ?? "");
        if (!/text\/|html|xml|json/i.test(type)) {
          res.destroy();
          return reject(new FetchError(`не текст (${type || "без типа"}) — вставьте текст лицензии`));
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            reject(new FetchError("страница больше 2 МБ"));
          } else chunks.push(c);
        });
        res.on("end", () => resolve({ status, type, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new FetchError("страница не ответила за 10 с")));
    req.on("error", (e) => reject(e instanceof FetchError ? e : new FetchError(e.message)));
    req.end();
  });
}

/** Скачать страницу (до 3 переходов, каждый — с той же проверкой). */
export async function safeFetch(raw: string): Promise<{ url: string; html: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError("неверная ссылка");
  }
  for (let hop = 0; hop < 4; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchError("только http и https");
    if (url.username || url.password) throw new FetchError("ссылки с логином не поддерживаются");
    const r = await getOnce(url);
    if (r.location && r.status >= 300 && r.status < 400) {
      url = new URL(r.location, url);
      continue;
    }
    if (r.status >= 400) throw new FetchError(`страница ответила ${r.status}`);
    return { url: url.toString(), html: r.body };
  }
  throw new FetchError("слишком много перенаправлений");
}

const ENT: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  laquo: "«",
  raquo: "»",
  mdash: "—",
  ndash: "–",
};
/** Блоки, которые выкидываются вместе с содержимым. */
const SKIP_BLOCKS = new Set(["script", "style", "noscript", "svg", "nav", "header", "footer"]);
/** Закрывающие теги, после которых в тексте перенос строки. */
const LINE_BREAK_CLOSE = /^(?:p|div|li|h\d|tr|section)$/;
const LICENSE_HINT = /licen[cs]e|eula|terms|лицензи|соглашени/i;
const HREF = /href\s*=\s*["']([^"'#]+)["']/i;

/** Строчные только латинские буквы: длина строки не меняется, позиции совпадают с исходной. */
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (c) => c.toLowerCase());

/** Ищет `needle` в `low` от `from`; `from` для одной строки только растёт — кэш делает все поиски линейными. */
function closeFinder(low: string) {
  const next = new Map<string, number>();
  return (needle: string, from: number): number => {
    const cached = next.get(needle);
    if (cached !== undefined && (cached === -1 || cached >= from)) return cached;
    const at = low.indexOf(needle, from);
    next.set(needle, at);
    return at;
  };
}

type Tag = { start: number; end: number; name: string; closing: boolean; nameEnd: number };

/**
 * Обходит теги `<…>` слева направо, `visit` возвращает, откуда продолжать (или ничего — сразу после тега).
 * Линейно: «>» ищется от «<» один раз, без возвратов (было `/<[^>]+>/g` — квадратично на «<<<<…»).
 */
function scanTags(html: string, low: string, visit: (tag: Tag, textBefore: string) => number | void): string {
  let textStart = 0;
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) break;
    if (html[lt + 1] === ">") {
      pos = lt + 2; // «<>» — не тег, остаётся в тексте
      continue;
    }
    const gt = html.indexOf(">", lt + 2);
    if (gt === -1) break;
    const closing = html[lt + 1] === "/";
    const nameStart = closing ? lt + 2 : lt + 1;
    let nameEnd = nameStart;
    while (nameEnd < gt && /[a-z0-9]/.test(low[nameEnd])) nameEnd++;
    const tag = { start: lt, end: gt + 1, name: low.slice(nameStart, nameEnd), closing, nameEnd };
    pos = visit(tag, html.slice(textStart, lt)) ?? gt + 1;
    textStart = pos;
  }
  return html.slice(textStart);
}

/** Теги → пробел (линейно). */
export function stripTags(html: string): string {
  let out = "";
  const tail = scanTags(html, asciiLower(html), (_tag, before) => {
    out += `${before} `;
  });
  return out + tail;
}

/**
 * HTML → текст (без скриптов, стилей и меню), плюс заголовок и ссылки на страницу лицензии.
 * Без регулярных выражений по всей странице: время линейно от размера (страница до 2 МБ).
 */
export function htmlToText(html: string, base?: string): { title: string; text: string; licenseLinks: string[] } {
  const low = asciiLower(html);
  let findClose = closeFinder(low);
  // Проход 1 — по всей странице, включая меню и подвал: там обычно и ссылка на лицензию.
  const licenseLinks: string[] = [];
  let title: string | null = null;
  let linkEnd = 0; // ссылки не пересекаются: <a> внутри текста другой ссылки не считается
  scanTags(html, low, (tag) => {
    if (tag.closing) return;
    if (tag.name === "title" && title === null) {
      const close = findClose("</title>", tag.end);
      if (close !== -1) title = html.slice(tag.end, close).trim();
    }
    if (tag.name !== "a" || tag.start < linkEnd) return;
    const href = HREF.exec(html.slice(tag.nameEnd, tag.end - 1))?.[1];
    const close = findClose("</a>", tag.end);
    if (!href || close === -1) return;
    linkEnd = close + 4;
    if (LICENSE_HINT.test(`${href} ${stripTags(html.slice(tag.end, close))}`)) {
      try {
        licenseLinks.push(new URL(href, base).toString());
      } catch {
        /* битая ссылка */
      }
    }
  });
  // Проход 2 — текст: блоки целиком в пробел, концы абзацев в перенос, прочие теги в пробел.
  findClose = closeFinder(low);
  let out = "";
  const tail = scanTags(html, low, (tag, before) => {
    out += before;
    if (tag.closing) {
      out += LINE_BREAK_CLOSE.test(tag.name) && tag.nameEnd === tag.end - 1 ? "\n" : " ";
      return;
    }
    if (tag.name === "br" && /^\s*\/?$/.test(html.slice(tag.nameEnd, tag.end - 1))) {
      out += "\n";
      return;
    }
    out += " ";
    if (SKIP_BLOCKS.has(tag.name)) {
      const close = findClose(`</${tag.name}>`, tag.end);
      if (close !== -1) return close + tag.name.length + 3;
    }
  });
  out += tail;
  const text = out
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (e, c: string) =>
      c[0] === "#"
        ? String.fromCodePoint(c[1].toLowerCase() === "x" ? Number.parseInt(c.slice(2), 16) : Number(c.slice(1)))
        : (ENT[c.toLowerCase()] ?? e),
    )
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return { title: decodeTitle(title ?? ""), text, licenseLinks: [...new Set(licenseLinks)].slice(0, 5) };
}
const decodeTitle = (t: string) =>
  t
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
