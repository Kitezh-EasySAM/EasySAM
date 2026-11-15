/**
 * Колокольчик: все текущие проблемы одним списком (не история, а «что сейчас не так»). Пересчитывается на каждый
 *   запрос.
 * Уровни: red — нарушение, yellow — требует внимания, info — к сведению. `id` стабилен — фронт помечает прочитанное.
 * Тесты: test/notifications.test.ts
 */
import type { DB } from "../db.ts";
import { listLicenseKeys } from "./licenses.ts";
import { listProcesses } from "./processes.ts";
import { listPurchases } from "./purchases.ts";
import { complianceReport } from "./report.ts";

export interface Notice {
  id: string;
  level: "red" | "yellow" | "info";
  category: string;
  title: string;
  text: string;
  link: string | null;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10,
    m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const pk = (n: number) => `${n} ${plural(n, "ПК", "ПК", "ПК")}`;

/** Колокольчик: все текущие проблемы (compliance, лицензии ПК, теневое ПО, неопознанное), важные первыми. */
export function notifications(db: DB) {
  const out: Notice[] = [];
  const rep = complianceReport(db);
  for (const r of rep.rows) {
    if (r.status === "over")
      out.push({
        id: `lic-short-${r.catalog_id}-${r.installed}-${r.seats}`,
        level: "red",
        category: "Лицензии",
        title: `Не хватает лицензий: ${r.name}`,
        text: `Установлено на ${pk(r.installed)}, куплено ${r.seats} — не хватает ${r.deficit}`,
        link: `/catalog/${r.catalog_id}`,
      });
    if (r.status === "forbidden")
      out.push({
        id: `forbidden-${r.catalog_id}-${r.installed}`,
        level: "red",
        category: "Запрещённое ПО",
        title: `Запрещённое ПО: ${r.name}`,
        text: `Найдено на ${pk(r.installed)}`,
        link: `/catalog/${r.catalog_id}`,
      });
  }
  for (const p of listPurchases(db, {})) {
    if (p.status === "expiring")
      out.push({
        id: `purchase-exp-${p.id}`,
        level: "yellow",
        category: "Договоры",
        title: `Истекает договор: ${p.catalog_name}`,
        text: `${p.seats} мест до ${p.valid_until} (через ${p.days_left} дн.)${p.contract ? `, ${p.contract}` : ""}`,
        link: "/purchases",
      });
    else if (p.status === "expired" && p.installed > 0 && (p.days_left ?? 0) > -90)
      out.push({
        id: `purchase-expired-${p.id}`,
        level: "yellow",
        category: "Договоры",
        title: `Истёк договор: ${p.catalog_name}`,
        text: `${p.seats} мест закончились ${p.valid_until}${p.contract ? `, ${p.contract}` : ""}`,
        link: "/purchases",
      });
  }
  const keys = listLicenseKeys(db, {}).summary;
  if (keys.unlicensed)
    out.push({
      id: `keys-unlic-${keys.unlicensed}`,
      level: "red",
      category: "Активация",
      title: "Не активированы Windows/Office/ПО",
      text: `${keys.unlicensed} ${plural(keys.unlicensed, "лицензия", "лицензии", "лицензий")} без активации`,
      link: null,
    });
  if (keys.key_reuse_keys)
    out.push({
      id: `keys-reuse-${keys.key_reuse_rows}`,
      level: "red",
      category: "Активация",
      title: "Один ключ на нескольких ПК",
      text: `${keys.key_reuse_keys} ${plural(keys.key_reuse_keys, "ключ", "ключа", "ключей")} стоят на ${pk(keys.key_reuse_rows)} — больше, чем куплено`,
      link: null,
    });
  if (keys.expiring || keys.expired)
    out.push({
      id: `keys-exp-${keys.expiring}-${keys.expired}`,
      level: "yellow",
      category: "Активация",
      title: "Сроки лицензий на ПК",
      text: [
        keys.expired && `истекло: ${keys.expired}`,
        keys.expiring && `истекает за ${keys.expiring_days} дн.: ${keys.expiring}`,
      ]
        .filter(Boolean)
        .join(", "),
      link: null,
    });
  const pr = listProcesses(db, { limit: 1 }).summary;
  if (pr.forbidden_running)
    out.push({
      id: `proc-forbidden-${pr.forbidden_running}`,
      level: "red",
      category: "Запуски",
      title: "Запускалось запрещённое ПО",
      text: `${pr.forbidden_running} ${plural(pr.forbidden_running, "запуск", "запуска", "запусков")}`,
      link: null,
    });
  if (pr.portable)
    out.push({
      id: `proc-portable-${pr.portable}`,
      level: "yellow",
      category: "Запуски",
      title: "Запускалось неустановленное ПО",
      text: `${pr.portable} ${plural(pr.portable, "программа", "программы", "программ")} из Загрузок/профиля, без установки`,
      link: null,
    });
  const lost = (
    db
      .prepare(
        "SELECT COUNT(*) c FROM device WHERE agent_last_seen IS NOT NULL AND agent_last_seen < datetime('now', '-7 days')",
      )
      .get() as { c: number }
  ).c;
  if (lost)
    out.push({
      id: `agents-lost-${lost}`,
      level: "yellow",
      category: "Агенты",
      title: "Агенты без связи больше 7 дней",
      text: pk(lost),
      link: "/agents",
    });
  const unknown = (
    db
      .prepare("SELECT COUNT(DISTINCT norm_name) c FROM installation WHERE catalog_id IS NULL AND is_noise = 0")
      .get() as { c: number }
  ).c;
  if (unknown)
    out.push({
      id: `unmatched-${unknown}`,
      level: "info",
      category: "Каталог",
      title: "Нераспределённые программы",
      text: `${unknown} ${plural(unknown, "название", "названия", "названий")} ждут привязки к каталогу`,
      link: "/catalog/unmatched",
    });

  const order = { red: 0, yellow: 1, info: 2 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  return {
    counts: {
      red: out.filter((n) => n.level === "red").length,
      yellow: out.filter((n) => n.level === "yellow").length,
      info: out.filter((n) => n.level === "info").length,
      total: out.length,
    },
    items: out,
  };
}
