import { describe, expect, test } from "vitest";
import {
  PASSWORD_RULES,
  loginProblem,
  nameProblem,
  passwordProblems,
  passwordScore,
  randomPassword,
} from "./passwordPolicy.ts";

// Те же случаи, что в server/test/auth.test.ts: правила на фронте — зеркало серверных.
describe("passwordPolicy", () => {
  test("логин", () => {
    expect(loginProblem("ivanov.i")).toBeNull();
    for (const bad of ["iv", "1ivanov", "Иванов", "ivan ov", "ivan..ov", "ivanov-", "root"])
      expect(loginProblem(bad), bad).not.toBeNull();
  });

  test("ФИО", () => {
    expect(nameProblem("Иванов Иван Иванович")).toBeNull();
    expect(nameProblem("Д'Артаньян Шарль")).toBeNull();
    expect(nameProblem("Иванов")).not.toBeNull();
    expect(nameProblem("Иванов 123")).not.toBeNull();
    expect(nameProblem(null)).not.toBeNull();
  });

  test("пароль: каждое правило срабатывает", () => {
    const ctx = { login: "ivanov.i", name: "Иванов Иван" };
    expect(passwordProblems("Kedr#Taiga-29", ctx)).toEqual([]);
    const has = (p: string, rule: string, c = {}) => passwordProblems(p, c).some((x) => x.includes(rule));
    expect(has("Ab1!", "10 символов")).toBe(true);
    expect(has("A".repeat(130) + "b1!", "128 символов")).toBe(true);
    expect(has("kedr#taiga-29", "заглавная")).toBe(true);
    expect(has("KEDR#TAIGA-29", "строчная")).toBe(true);
    expect(has("Kedr#Taiga-xx", "цифра")).toBe(true);
    expect(has("KedrTaiga29xy", "спецсимвол")).toBe(true);
    expect(has("Keeedr#Taiga-29", "трёх одинаковых")).toBe(true);
    expect(has("Kedr#Taiga-1234", "последовательностей")).toBe(true);
    expect(has("Ivanov#Taiga-29", "логин и ФИО", ctx)).toBe(true);
    expect(has("P@ssw0rd!", "распространённых")).toBe(true);
    expect(has("Passwordiii#9", "распространённых")).toBe(true); // «i» на конце после замен срезается
  });

  test("оценка надёжности и список правил", () => {
    expect(passwordScore("")).toBe(0);
    expect(passwordScore("abc")).toBe(1);
    expect(passwordScore("Kedr#taiga")).toBe(2);
    expect(passwordScore("Kedr#Taiga-29")).toBe(3);
    expect(passwordScore("Kedr#Taiga-29-Ob")).toBe(4);
    expect(PASSWORD_RULES).toContain("цифра");
  });

  test("сгенерированный пароль проходит правила", () => {
    for (let i = 0; i < 20; i++) {
      const p = randomPassword();
      expect(p).toHaveLength(16);
      expect(passwordProblems(p)).toEqual([]);
    }
  });
});
