import { describe, expect, test } from "vitest";
import { revealRadius } from "./motion.ts";

describe("motion", () => {
  test("revealRadius: круг от точки закрывает весь экран — до самого дальнего угла", () => {
    expect(revealRadius(0, 0, 300, 400)).toBe(500); // из угла — диагональ
    expect(revealRadius(1180, 28, 1200, 800)).toBe(Math.ceil(Math.hypot(1180, 772))); // кнопка темы справа вверху
    expect(revealRadius(150, 200, 300, 400)).toBe(250); // из центра — полдиагонали
  });
});
