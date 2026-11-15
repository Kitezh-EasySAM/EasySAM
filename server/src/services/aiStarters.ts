/**
 * Карточки начала разговора в ассистенте — из текущих данных (GET /api/ai/info → starters). Тесты:
 * test/assistant.test.ts
 */
import type { DB } from "../db.ts";
import { n } from "./aiTypes.ts";
import { listPurchases } from "./purchases.ts";
import { reallocation } from "./reallocation.ts";
import { complianceReport } from "./report.ts";

/**
 * С чего начать разговор: не заготовленные примеры, а то, что есть в базе прямо сейчас (число + вопрос, на который
 * правила ответят непусто). Пустая база или всё в порядке → пустой список. Не больше четырёх, важное первым.
 */
export interface Starter {
  title: string;
  value: string;
  level: "red" | "yellow" | "info";
  question: string;
}
/** До четырёх карточек начала разговора из текущих данных; пустой список — база пуста или всё в порядке. */
export function starters(db: DB): Starter[] {
  const rows = complianceReport(db).rows;
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const pcs = (k: number) => `${n(k)} ПК`;
  const out: Starter[] = [];
  const deficit = sum(rows.filter((r) => r.status === "over").map((r) => r.deficit));
  if (deficit)
    out.push({
      title: "Не хватает лицензий",
      value: `${n(deficit)} мест`,
      level: "red",
      question: "Чего не хватает по лицензиям?",
    });
  const forbidden = sum(rows.filter((r) => r.status === "forbidden").map((r) => r.installed));
  if (forbidden)
    out.push({ title: "Запрещённое ПО", value: pcs(forbidden), level: "red", question: "Где стоит запрещённое ПО?" });
  const movable = reallocation(db).total_covered;
  if (movable)
    out.push({
      title: "Можно перенести без закупки",
      value: `${n(movable)} лицензий`,
      level: "yellow",
      question: "Какие лицензии можно перенести и куда?",
    });
  const expiring = listPurchases(db, {}).filter((p) => p.status === "expiring" || p.status === "expired").length;
  if (expiring)
    out.push({
      title: "Договоры истекают",
      value: n(expiring),
      level: "yellow",
      question: "Что истекает в ближайший месяц?",
    });
  const idle = sum(rows.map((r) => r.idle));
  if (idle)
    out.push({
      title: "Лицензии простаивают",
      value: `${n(idle)} мест`,
      level: "yellow",
      question: "Какие лицензии простаивают?",
    });
  const unknown = (
    db
      .prepare("SELECT COUNT(DISTINCT norm_name) c FROM installation WHERE catalog_id IS NULL AND is_noise = 0")
      .get() as { c: number }
  ).c;
  if (unknown)
    out.push({
      title: "Нераспределённое ПО",
      value: `${n(unknown)} названий`,
      level: "info",
      question: "Сколько нераспределённого ПО?",
    });
  return out.slice(0, 4);
}
