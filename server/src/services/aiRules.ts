/** Ассистент без модели: распознавание вопроса правилами и ответ с таблицей из базы. Тесты: test/assistant.test.ts */
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { deviceAnswer, findProgram, programAnswer, programTerm } from "./aiFind.ts";
import { starters } from "./aiStarters.ts";
import { fmtDate, n, places, type ChatAnswer } from "./aiTypes.ts";
import { listLicenseKeys } from "./licenses.ts";
import { listPurchases } from "./purchases.ts";
import { reallocation } from "./reallocation.ts";
import { complianceReport } from "./report.ts";

/** Сумма поля по строкам. */
const sum = <T>(rows: T[], f: (r: T) => number) => rows.reduce((s, r) => s + f(r), 0);

/** Ответ по правилам; null — правила вопрос не поняли. */
export function answerByRules(db: DB, question: string): ChatAnswer | null {
  const q = question.toLowerCase().replace(/ё/g, "е").trim();
  if (!q || /^(помощь|help|что (ты )?умеешь|привет)/.test(q))
    return {
      answer: "Я отвечаю на вопросы о программах, компьютерах и лицензиях.",
      intent: "help",
      source: "rules",
      suggestions: starters(db).map((s) => s.question),
    };

  if (/перенес|перенос|перераспредел|освобод|куда .*лиценз|можно .*(снять|забрать|отдать)/.test(q)) {
    const r = reallocation(db);
    const top = r.items.filter((i) => i.covered || i.donors.length).slice(0, 10);
    return {
      answer: top.length
        ? `Можно перераспределить ${r.total_covered} лиц. без закупки и сэкономить около ${n(r.total_savings)} ₽. ` +
          `Доноры — установки у уволенных и не запускавшиеся больше ${r.stale_days} дней.\n` +
          top
            .slice(0, 4)
            .map((i) => "• " + i.text)
            .join("\n")
        : "Сейчас переносить нечего: неиспользуемых платных установок нет.",
      intent: "reallocation",
      source: "rules",
      table: {
        columns: ["ПО", "Не хватает", "Снять с", "Отдать", "Экономия, ₽"],
        rows: top.map((i) => [
          i.name,
          i.deficit || null,
          i.donors
            .slice(0, Math.max(i.covered, Math.min(3, i.donors.length)))
            .map((d) => `${d.hostname ?? d.device_serial} (${d.reason})`)
            .join("; "),
          i.moves.map((m) => m.to.hostname ?? m.to.device_serial).join(", ") ||
            (i.deficit ? "—" : "вернуть / не продлевать"),
          i.savings,
        ]),
      },
    };
  }
  if (/истека|истек|продл|срок/.test(q)) {
    const ps = listPurchases(db, {})
      .filter((p) => p.status === "expiring" || p.status === "expired")
      .sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0));
    const keys = listLicenseKeys(db, {}).summary;
    return {
      answer:
        (ps.length
          ? `Договоров со сроком в ближайший месяц или уже истёкших: ${ps.length}.`
          : "Истекающих договоров нет.") +
        (keys.expiring || keys.expired ? ` Лицензии на ПК: истекает ${keys.expiring}, истекло ${keys.expired}.` : ""),
      intent: "expiring",
      source: "rules",
      table: ps.length
        ? {
            columns: ["ПО", "Мест", "Действует до", "Осталось", "Договор"],
            rows: ps.map((p) => [
              p.catalog_name,
              p.seats,
              fmtDate(p.valid_until),
              (p.days_left ?? 0) < 0 ? "истёк" : `${p.days_left} дн.`,
              p.contract,
            ]),
          }
        : undefined,
      links: [{ label: "Закупки", href: "/purchases" }],
    };
  }
  if (/простаива|не использу|зомби|лишн|свободн/.test(q)) {
    const rows = complianceReport(db)
      .rows.filter((r) => r.idle > 0 || r.zombie > 0)
      .sort((a, b) => b.waste + b.reclaimable - (a.waste + a.reclaimable));
    return {
      answer: rows.length
        ? `Простаивают места по ${rows.length} позициям: не установлено ${sum(rows, (r) => r.idle)} купленных мест, ` +
          `ещё ${sum(rows, (r) => r.zombie)} установок давно не запускались.`
        : "Простаивающих лицензий нет.",
      intent: "idle",
      source: "rules",
      table: rows.length
        ? {
            columns: ["ПО", "Куплено", "Установлено", "Свободно", "Не запускали", "₽ можно вернуть"],
            rows: rows.map((r) => [
              r.name,
              r.seats,
              r.installed,
              r.idle,
              r.zombie,
              Math.round(r.waste + r.reclaimable),
            ]),
          }
        : undefined,
    };
  }
  if (/не хватает|нехват|превыш|нарушени|недостат|докуп/.test(q)) {
    const rows = complianceReport(db).rows.filter((r) => r.status === "over");
    return {
      answer: rows.length
        ? `Лицензий не хватает по ${rows.length} программам: всего ${sum(rows, (r) => r.deficit)} мест, ` +
          `оценка риска ${n(sum(rows, (r) => r.penalty))} ₽.`
        : "Всем установкам хватает купленных лицензий.",
      intent: "shortage",
      source: "rules",
      table: rows.length
        ? {
            columns: ["ПО", "Установлено на ПК", "Куплено", "Не хватает"],
            rows: rows.map((r) => [r.name, r.installed, r.seats, r.deficit]),
          }
        : undefined,
      suggestions: ["Какие лицензии можно перенести и куда?"],
    };
  }
  if (/запрещ/.test(q) && !/у кого стоит [^з]/.test(q)) {
    const rows = db
      .prepare(
        `SELECT c.name, d.hostname, i.device_serial, e.full_name, e.department, i.raw_version FROM installation i
       JOIN software_catalog c ON c.id = i.catalog_id JOIN device d ON d.serial_number = i.device_serial LEFT JOIN employee e ON e.id = d.employee_id
       WHERE c.internal_status = 'forbidden' AND i.is_noise = 0 ORDER BY c.name, d.hostname`,
      )
      .all() as {
      name: string;
      hostname: string | null;
      device_serial: string;
      full_name: string | null;
      department: string | null;
      raw_version: string | null;
    }[];
    return {
      answer: rows.length
        ? `Запрещённое ПО найдено на ${new Set(rows.map((r) => r.device_serial)).size} ПК.`
        : "Запрещённого ПО не найдено.",
      intent: "forbidden",
      source: "rules",
      table: rows.length
        ? {
            columns: ["ПО", "ПК", "Сотрудник", "Отдел", "Версия"],
            rows: rows.map((r) => [r.name, r.hostname ?? r.device_serial, r.full_name, r.department, r.raw_version]),
          }
        : undefined,
    };
  }
  if (/неопознан|нераспозн|не распозн|нераспредел|не распредел/.test(q)) {
    const top = db
      .prepare(
        `SELECT MIN(raw_name) AS name, COUNT(DISTINCT device_serial) AS n FROM installation WHERE catalog_id IS NULL AND is_noise = 0
       GROUP BY norm_name ORDER BY n DESC LIMIT 15`,
      )
      .all() as { name: string; n: number }[];
    const total = (
      db
        .prepare("SELECT COUNT(DISTINCT norm_name) c FROM installation WHERE catalog_id IS NULL AND is_noise = 0")
        .get() as { c: number }
    ).c;
    return {
      answer: `Нераспределённых названий: ${total}. Самые массовые — в таблице.`,
      intent: "unmatched",
      source: "rules",
      table: { columns: ["Название", "ПК"], rows: top.map((r) => [r.name, r.n]) },
      links: [{ label: "Нераспределённое", href: "/catalog/unmatched" }],
    };
  }
  const dev = deviceAnswer(db, q);
  if (dev) return dev;
  if (/сколько стоит|сколько стоят|цена|стоимост|во сколько обош/.test(q)) {
    const term = programTerm(
      q.replace(/сколько стоит|сколько стоят|цена|стоимость|во сколько обошл[аи]сь|обошлось/g, " "),
    );
    const p = term ? findProgram(db, term) : null;
    if (p?.kind === "catalog") {
      const ps = listPurchases(db, { catalog_id: p.id });
      const live = ps.filter((x) => x.status !== "expired");
      const price = (
        db.prepare("SELECT list_price FROM software_catalog WHERE id = ?").get(p.id) as { list_price: number | null }
      ).list_price;
      const unit = live.length
        ? live.reduce((s, x) => s + x.unit_price * x.seats, 0) /
          Math.max(
            1,
            live.reduce((s, x) => s + x.seats, 0),
          )
        : (price ?? 0);
      return {
        answer: live.length
          ? `${p.name}: в среднем ${n(unit)} ₽ за место; действующие договоры — ` +
            `${places(sum(live, (x) => x.seats))} на ${n(sum(live, (x) => x.total_cost))} ₽.`
          : unit
            ? `${p.name}: закупок нет, справочная цена ${n(unit)} ₽ за место.`
            : `${p.name}: цен нет — бесплатное ПО или закупка не внесена.`,
        intent: "price",
        source: "rules",
        table: ps.length
          ? {
              columns: ["Договор", "Мест", "Цена места, ₽", "Сумма, ₽", "Действует до"],
              rows: ps.map((x) => [
                x.contract,
                x.seats,
                x.unit_price,
                x.total_cost,
                x.valid_until ? fmtDate(x.valid_until) : "бессрочно",
              ]),
            }
          : undefined,
        links: [{ label: "Закупки", href: "/purchases" }],
      };
    }
  }
  if (/сколько (всего )?(пк|компьютер|устройств|агент|машин)|сколько .*в сети/.test(q)) {
    const r = db
      .prepare(
        `SELECT COUNT(*) total, SUM(agent_last_seen >= datetime('now', ?)) online, SUM(agent_last_seen IS NULL) no_agent FROM device`,
      )
      .get(`-${config.agentOnlineSeconds} seconds`) as {
      total: number;
      online: number | null;
      no_agent: number | null;
    };
    return {
      answer: `Всего ПК: ${r.total}. С агентом в сети: ${r.online ?? 0}, без агента (данные из загрузки файла): ${r.no_agent ?? 0}.`,
      intent: "devices",
      source: "rules",
      links: [{ label: "Рабочие места", href: "/agents" }],
    };
  }
  if (/(у кого|кто|на каких|где|у скольких|сколько|стоит|установлен)/.test(q))
    return programAnswer(db, q, /у кого|кто|на каких|где/.test(q));
  // последний шанс: вопрос — просто название программы
  return programAnswer(db, q, false);
}
