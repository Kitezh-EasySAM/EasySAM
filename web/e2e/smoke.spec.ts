import { expect, test, type Page } from "@playwright/test";
import { settled } from "./util.ts";

// Обход всех экранов на ширине компьютера и телефона: без ошибок страницы и консоли, без 5xx,
// без горизонтальной прокрутки и без «NaN / undefined / [object Object] / Invalid Date» в тексте.

const ROUTES = [
  "/dashboard",
  "/agents",
  "/agents/setup",
  "/agents/1",
  "/agents/1/licenses",
  "/agents/1/processes",
  "/agents/1/events",
  "/catalog",
  "/catalog/1",
  "/purchases",
  "/catalog/unmatched",
  "/events",
  "/settings",
  "/settings/keys",
  "/settings/installs",
  "/settings/users",
  "/assistant",
];
const NOT_FOUND = "/agents/999999";

function watch(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // ожидаемые 404: карточка несуществующего ПК
    if (page.url().endsWith(NOT_FOUND) && t.includes("404")) return;
    problems.push(`console: ${t}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`);
  });
  return problems;
}

for (const [label, width, height] of [
  ["1440", 1440, 900],
  ["400", 400, 860],
] as const) {
  test(`все экраны без ошибок, ${label} px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const problems = watch(page);
    for (const url of [...ROUTES, NOT_FOUND]) {
      await settled(page, url);
      const { scroll, inner, text } = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
        text: document.body.innerText,
      }));
      expect(scroll, `${url}: горизонтальная прокрутка`).toBeLessThanOrEqual(inner);
      expect(text, `${url}: мусор в тексте`).not.toMatch(/NaN|undefined|\[object Object\]|Invalid Date/);
    }
    await settled(page, NOT_FOUND);
    await expect(page.getByText("Не найдено")).toBeVisible();
    expect(
      problems.filter((p) => !p.includes("Refused to")),
      "ошибки",
    ).toEqual([]);
    expect(
      problems.filter((p) => p.includes("Refused to")),
      "CSP что-то заблокировала",
    ).toEqual([]);
  });
}

test("старые адреса «Ввода данных» ведут на новые места", async ({ page }) => {
  const map: Record<string, string> = {
    "/data": "/settings",
    "/data/catalog": "/catalog",
    "/data/purchases": "/purchases",
    "/data/employees": "/settings/employees",
    "/data/keys": "/settings/keys",
    "/data/installs": "/settings/installs",
    "/data/users": "/settings/users",
  };
  for (const [from, to] of Object.entries(map)) {
    await settled(page, from);
    await expect(page, from).toHaveURL(new RegExp(`${to}$`));
  }
});
