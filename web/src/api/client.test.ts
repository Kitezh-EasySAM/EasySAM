import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { apiUrl } from "./client.ts";

describe("apiUrl — только свой сервер и /api/…", () => {
  beforeAll(() => vi.stubGlobal("window", { location: { origin: "http://sam.local:8000" } }));
  afterAll(() => vi.unstubAllGlobals());

  it("пропускает обычные адреса API с параметрами", () => {
    expect(apiUrl("/api/devices/12")).toBe("/api/devices/12");
    expect(apiUrl("/api/unmatched?limit=50&q=%D0%BA%D1%80")).toBe("/api/unmatched?limit=50&q=%D0%BA%D1%80");
  });

  it("не выпускает за пределы /api/ через «..» и %2e%2e", () => {
    expect(() => apiUrl("/api/../downloads/sam-agent.exe")).toThrow();
    expect(() => apiUrl("/api/devices/%2e%2e/%2e%2e/secret")).toThrow();
    expect(() => apiUrl("/downloads/x")).toThrow();
  });

  it("не уходит на чужой хост", () => {
    expect(() => apiUrl("http://evil.example/api/x")).toThrow();
    expect(() => apiUrl("//evil.example/api/x")).toThrow();
  });
});
