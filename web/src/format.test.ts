import { afterEach, describe, expect, test, vi } from "vitest";
import { aiAddHref, dateRu, kindLabel, num, presence, relTime, rub, thinkingLabel } from "./format.ts";

describe("format", () => {
  afterEach(() => vi.useRealTimers());

  test("thinkingLabel: сначала без секунд, потом счётчик, после 20 с — предупреждение", () => {
    expect(thinkingLabel(0)).toBe("Думаю");
    expect(thinkingLabel(3)).toBe("Думаю · 3 с");
    expect(thinkingLabel(20)).toBe("Модель думает дольше обычного · 20 с");
  });

  test("aiAddHref: название → запрос на добавление, ссылка → как есть", () => {
    expect(decodeURIComponent(aiAddHref(" winrar "))).toBe("/assistant?q=Добавь в одобренное ПО: winrar");
    expect(decodeURIComponent(aiAddHref("https://7-zip.org/license.txt"))).toBe(
      "/assistant?q=https://7-zip.org/license.txt",
    );
  });

  test("kindLabel, num, rub, dateRu", () => {
    expect(kindLabel("open_source")).toBe("Open source");
    expect(kindLabel("unknown_kind")).toBe("unknown_kind");
    expect(kindLabel(null)).toBe("");
    expect(num(1277000)).toBe("1 277 000"); // обычные пробелы: в CSV и Excel число не разваливается
    expect(num(null)).toBe("");
    expect(rub(1500)).toBe("1 500 ₽");
    expect(dateRu(null)).toBe("—");
    expect(dateRu("2027-12-31")).toBe("31.12.2027");
  });

  test("relTime: давность по времени UTC из SQLite", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    expect(relTime(null)).toBe("нет данных");
    expect(relTime("2026-11-15 11:59:40")).toBe("только что");
    expect(relTime("2026-11-15 11:15:00")).toBe("45 мин назад");
    expect(relTime("2026-11-15 09:00:00")).toBe("3 ч назад");
    expect(relTime("2026-11-10 12:00:00")).toBe("5 дн назад");
  });

  test("presence: онлайн / не в сети / нет связи / без агента", () => {
    expect(presence({ agent_status: "online" })).toBe("online");
    expect(presence({ agent_status: "offline" })).toBe("offline");
    expect(presence({ agent_status: "lost" })).toBe("lost");
    expect(presence({ agent_status: null })).toBe("no_agent");
    expect(presence({})).toBe("no_agent");
  });
});
