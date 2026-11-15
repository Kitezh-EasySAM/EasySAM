/**
 * Ассистент без модели: поиск программы по свободному названию (нечётко, с транслитом) и ответы
 * «у кого / у скольких стоит X», «что стоит у <ФИО|ПК>». Тесты: test/assistant.test.ts
 */
import { config } from "../config.ts";
import { likeContains, type DB } from "../db.ts";
import { daysAgo, lastRun, type ChatAnswer } from "./aiTypes.ts";
import { similarity } from "./fuzzy.ts";
import { normalizeName } from "./normalize.ts";
import { complianceReport } from "./report.ts";

const STOP = new Set(
  (
    "у кого кто где какие каких какой какая сколько скольких человек людей сотрудников пк компьютер компьютерах компьютеров машин машинах " +
    "стоит стоят установлен установлена установлено установлены установленный есть ли на в во с со по и а программа программы программу софт " +
    "по приложение приложения лицензия лицензии лицензий всего сейчас нас наших у них это эта этот прога"
  ).split(" "),
);

/** Найти программу по свободному названию: позиция каталога или группа «сырых» названий установок. */
export function findProgram(
  db: DB,
  term: string,
):
  | { kind: "catalog"; id: number; name: string; score: number }
  | { kind: "raw"; norms: string[]; name: string; score: number }
  | null {
  const t = normalizeName(term);
  if (t.length < 2) return null;
  const score = (cand: string) => {
    const s = similarity(t, cand);
    // вхождение слова целиком: «photoshop» ⊂ «adobe photoshop»
    return cand.split(" ").includes(t) || (t.length >= 4 && cand.includes(t)) ? Math.max(s, 0.9) : s;
  };
  let best: { kind: "catalog"; id: number; name: string; score: number } | null = null;
  for (const c of db.prepare("SELECT id, name FROM software_catalog").all() as { id: number; name: string }[]) {
    const s = score(normalizeName(c.name));
    if (!best || s > best.score) best = { kind: "catalog", id: c.id, name: c.name, score: s };
  }
  for (const a of db
    .prepare("SELECT a.norm_name, c.id, c.name FROM alias a JOIN software_catalog c ON c.id = a.catalog_id")
    .all() as { norm_name: string; id: number; name: string }[]) {
    const s = score(a.norm_name);
    if (!best || s > best.score) best = { kind: "catalog", id: a.id, name: a.name, score: s };
  }
  if (best && best.score >= 0.75) return best;
  // нет в каталоге — ищем среди установленного (напр. «Capture One»)
  const raws = db
    .prepare(
      "SELECT norm_name, MIN(raw_name) AS raw FROM installation WHERE is_noise = 0 AND catalog_id IS NULL GROUP BY norm_name",
    )
    .all() as { norm_name: string; raw: string }[];
  const hits = raws
    .map((r) => ({ ...r, s: score(r.norm_name) }))
    .filter((r) => r.s >= 0.75)
    .sort((a, b) => b.s - a.s);
  if (hits.length) return { kind: "raw", norms: hits.map((h) => h.norm_name), name: hits[0].raw, score: hits[0].s };
  return best && best.score >= 0.6 ? best : null;
}

/** Как программы называют в разговоре → как они называются в реестре. */
const SYNONYMS: [RegExp, string][] = [
  [/^(гугл\s*)?хром(а|е|ом)?$/, "google chrome"],
  [/^(майкрософт\s*)?офис(а|е|ом)?$/, "microsoft office"],
  [/^ворд(а|е|ом)?$/, "microsoft office"],
  [/^эксел[ья]?(е|ем)?$/, "microsoft office"],
  [/^аутлук(а|е)?$/, "microsoft office"],
  [/^визио$/, "microsoft visio"],
  [/^фотошоп(а|е|ом)?$/, "adobe photoshop"],
  [/^акробат(а|е)?$/, "adobe acrobat"],
  [/^автокад(а|е|ом)?$/, "autodesk autocad"],
  [/^касперск(ий|ого|ом)$/, "kaspersky endpoint security"],
  [/^винрар(а|е|ом)?$/, "winrar"],
  [/^(джава|ява)$/, "java"],
  [/^7\s*(?:-\s*)?(зип|zip)$/, "7-zip"],
  [/^семизип$/, "7-zip"],
  [/^(1с|1c|одинэс)$/, "1с"],
  [/^директум(а|е)?$/, "directum"],
  [/^яндекс(\s*браузер)?$/, "yandex"],
  [/^(эдж|edge)$/, "microsoft edge"],
  [/^(сап|sap)$/, "sap gui"],
  [/^(питон|пайтон)$/, "python"],
];

/** Название программы из вопроса: без служебных слов и с заменой синонимов («ворд» → word). */
export function programTerm(q: string): string {
  const t = q
    .replace(/[?!.,«»"']/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .join(" ")
    .trim();
  for (const [re, name] of SYNONYMS) if (re.test(t)) return name;
  return t;
}

function installsOf(db: DB, p: NonNullable<ReturnType<typeof findProgram>>) {
  const where = p.kind === "catalog" ? "i.catalog_id = ?" : `i.norm_name IN (${p.norms.map(() => "?").join(",")})`;
  const args = p.kind === "catalog" ? [p.id] : p.norms;
  return db
    .prepare(
      `SELECT d.hostname, i.device_serial, e.full_name AS employee, e.department, MAX(i.raw_version) AS version, MAX(i.last_used) AS last_used
     FROM installation i JOIN device d ON d.serial_number = i.device_serial LEFT JOIN employee e ON e.id = d.employee_id
     WHERE i.is_noise = 0 AND ${where} GROUP BY i.device_serial ORDER BY d.hostname`,
    )
    .all(...args) as {
    hostname: string | null;
    device_serial: string;
    employee: string | null;
    department: string | null;
    version: string | null;
    last_used: string | null;
  }[];
}

/** Ответ «у скольких / у кого стоит X»; null — программу в вопросе не нашли. */
export function programAnswer(db: DB, q: string, who: boolean): ChatAnswer | null {
  const term = programTerm(q);
  const p = term ? findProgram(db, term) : null;
  if (!p) return null;
  const rows = installsOf(db, p);
  const people = new Set(rows.map((r) => r.employee).filter(Boolean)).size;
  const rep = p.kind === "catalog" ? complianceReport(db).rows.find((r) => r.catalog_id === p.id) : undefined;
  const lic =
    rep && (rep.license_kind === "commercial" || rep.license_kind === "shareware" || rep.license_kind === "trial")
      ? ` Куплено лицензий: ${rep.seats}${rep.deficit ? ` — не хватает ${rep.deficit}` : rep.idle ? `, свободно ${rep.idle}` : ""}.`
      : "";
  const status = rep?.status === "forbidden" ? " Внимание: программа запрещена к установке." : "";
  const unused = rows.filter((r) => (daysAgo(r.last_used) ?? 0) > config.staleDays).length;
  const answer = rows.length
    ? `${p.name} установлен${p.kind === "raw" ? "а" : ""} на ${rows.length} ПК, ` +
      `у ${people} ${people % 10 === 1 && people % 100 !== 11 ? "сотрудника" : "сотрудников"}.${lic}${status}` +
      (unused ? ` ${unused} из них не запускали больше ${config.staleDays} дней.` : "") +
      (who ? "" : " Список — в таблице.")
    : `${p.name} сейчас ни на одном ПК не найден.`;
  return {
    answer,
    intent: who ? "who_has" : "how_many",
    source: "rules",
    table: rows.length
      ? {
          columns: ["ПК", "Сотрудник", "Отдел", "Версия", "Последний запуск"],
          rows: rows
            .slice(0, 200)
            .map((r) => [r.hostname ?? r.device_serial, r.employee, r.department, r.version, lastRun(r.last_used)]),
        }
      : undefined,
    links:
      p.kind === "catalog"
        ? [{ label: `Карточка «${p.name}»`, href: `/catalog/${p.id}` }]
        : [{ label: "Нераспределённое", href: "/catalog/unmatched" }],
  };
}

/** Ответ «что стоит у <ФИО|ПК>»; null — вопрос не про конкретного человека или ПК. */
export function deviceAnswer(db: DB, q: string): ChatAnswer | null {
  const m = /(?:что|какое по|какие программы)\s+(?:стоит|установлено|установлены|есть)\s+(?:у|на)\s+(\S.*)$/.exec(q);
  if (!m) return null;
  const who = m[1].replace(/[?!.]/g, "").trim();
  const stem = who.length > 5 ? who.slice(0, -2) : who; // «соколовой» → «соколов»
  const dev = db
    .prepare(
      `SELECT d.id, d.serial_number, d.hostname, e.full_name FROM device d LEFT JOIN employee e ON e.id = d.employee_id
     WHERE ulower(d.hostname) = ? OR ulower(e.full_name) LIKE ? ESCAPE '\\' ORDER BY d.hostname LIMIT 1`,
    )
    .get(who, likeContains(stem)) as
    { id: number; serial_number: string; hostname: string; full_name: string | null } | undefined;
  if (!dev) return { answer: `Не нашёл ПК или сотрудника «${who}».`, intent: "device", source: "rules" };
  const sw = db
    .prepare(
      `SELECT i.raw_name, i.raw_version, c.name AS catalog_name, c.internal_status, i.last_used FROM installation i
     LEFT JOIN software_catalog c ON c.id = i.catalog_id WHERE i.device_serial = ? AND i.is_noise = 0 ORDER BY c.internal_status = 'forbidden' DESC, i.raw_name`,
    )
    .all(dev.serial_number) as {
    raw_name: string;
    raw_version: string | null;
    catalog_name: string | null;
    internal_status: string | null;
    last_used: string | null;
  }[];
  const forb = sw.filter((s) => s.internal_status === "forbidden").length;
  return {
    answer: `На ${dev.hostname}${dev.full_name ? ` (${dev.full_name})` : ""} ${sw.length} программ${forb ? `, из них запрещённых: ${forb}` : ""}.`,
    intent: "device",
    source: "rules",
    table: {
      columns: ["Программа", "Версия", "Каталог", "Статус", "Последний запуск"],
      rows: sw.map((s) => [
        s.raw_name,
        s.raw_version,
        s.catalog_name,
        s.internal_status === "forbidden"
          ? "запрещено"
          : s.internal_status === "outdated"
            ? "устарело"
            : s.catalog_name
              ? "актуально"
              : "нераспределено",
        lastRun(s.last_used),
      ]),
    },
    links: [{ label: `Карточка ${dev.hostname}`, href: `/agents/${dev.id}` }],
  };
}
