import { expect, test, type Page } from "@playwright/test";
import { settled, total } from "./util.ts";

// Сценарии: плитки-фильтры, дубль в каталоге, «Заполнить с ИИ», Escape в окнах, удаление через подтверждение, роль «просмотр».

const tileValue = async (page: Page, label: string) => {
  const tile = page.locator("button.kpi").filter({ hasText: label });
  await tile.click();
  await expect(tile).toHaveAttribute("aria-pressed", "true");
  return Number((await tile.locator(".value").innerText()).replace(/\D/g, ""));
};

test("плитка-фильтр показывает столько строк, сколько на плитке", async ({ page }) => {
  await settled(page, "/dashboard");
  const problems = await tileValue(page, "Требуют внимания");
  await expect.poll(() => total(page)).toBe(problems);
  await settled(page, "/agents");
  for (const label of ["С запрещённым ПО", "Все ПК"]) {
    const n = await tileValue(page, label);
    await expect.poll(() => total(page), label).toBe(n);
  }
});

test("«Добавить ПО» с названием, которое уже есть, — понятная ошибка", async ({ page }) => {
  await settled(page, "/catalog");
  await page.getByRole("button", { name: "Добавить ПО" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").first().fill("7-Zip");
  await dialog.getByRole("button", { name: /^Добавить$/ }).click();
  await expect(dialog).toContainText("уже существует");
});

test("«Заполнить с ИИ»: чат с карточкой проверки, перезагрузка не шлёт вопрос повторно", async ({ page }) => {
  let asked = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/ai/chat")) asked++;
  });
  await settled(page, "/catalog");
  await page.getByRole("button", { name: "Добавить ПО" }).click();
  await page.getByRole("dialog").getByRole("combobox").first().fill("7-Zip");
  await page.getByRole("button", { name: /Заполнить с ИИ/ }).click();
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByRole("button", { name: /Добавить (в одобренное ПО|как запрещённое)/ })).toBeVisible();
  expect(asked).toBe(1);
  await page.reload();
  await settled(page);
  expect(asked).toBe(1);
});

test("Escape: сначала закрывает открытый список, потом окно", async ({ page }) => {
  await settled(page, "/purchases");
  await page.getByRole("button", { name: "Добавить закупку" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").first().click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("удаление сотрудника — через окно подтверждения", async ({ page }) => {
  await settled(page, "/settings");
  const before = await total(page);
  const name = (await page.locator(".t tbody tr td.strong").first().innerText()).trim();
  await page.getByRole("button", { name: `Удалить сотрудника «${name}»` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`Удалить сотрудника «${name}»?`);
  await dialog.getByRole("button", { name: "Отмена" }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole("button", { name: `Удалить сотрудника «${name}»` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Удалить" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => total(page)).toBe(before - 1);
});

test.describe("роль «просмотр»", () => {
  test.use({ storageState: "e2e/.auth/viewer.json" });
  test("нет кнопок изменения и вкладки «Пользователи», нет 403", async ({ page }) => {
    const forbidden: string[] = [];
    page.on("response", (r) => {
      if (r.status() === 403) forbidden.push(r.url());
    });
    for (const url of [
      "/catalog",
      "/catalog/1",
      "/purchases",
      "/settings",
      "/settings/keys",
      "/catalog/unmatched",
      "/agents",
    ]) {
      await settled(page, url);
      await settled(page);
      for (const name of [/Добавить/, /Импорт/, /Раздать/, /^Удалить/, /Подключить/, /Новый пользователь/])
        await expect(page.getByRole("button", { name }).filter({ visible: true }), `${url}: ${name}`).toHaveCount(0);
    }
    await settled(page, "/settings");
    await expect(page.getByRole("button", { name: /Пользователи/ })).toHaveCount(0);
    expect(forbidden).toEqual([]);
  });
});
