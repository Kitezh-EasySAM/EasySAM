import { expect, type Page } from "@playwright/test";

/**
 * Дождаться, что страница отрисовала данные. «Сеть затихла» (networkidle) не годится: живая лента
 * /api/stream (SSE) держит соединение открытым всё время, пока открыта страница.
 */
export async function settled(page: Page, url?: string) {
  if (url) await page.goto(url);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".page, .ai-shell, .login-bg").first()).toBeVisible();
  await expect(page.getByText("Загрузка…")).toHaveCount(0);
  await page.waitForTimeout(300); // догружаемые справочники (каталог для подсказок, продукты ключей)
}

/** Число строк таблицы по подписи «Показано 1–N из M» (M). */
export async function total(page: Page) {
  const foot = await page.locator(".card-foot").filter({ hasText: "Показано" }).first().innerText();
  return Number(/из\s+([\d\s]+)/.exec(foot)?.[1].replace(/\D/g, ""));
}
