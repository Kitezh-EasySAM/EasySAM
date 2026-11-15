import { defineConfig } from "vitest/config";

process.env.TZ = "Asia/Yekaterinburg"; // даты в тестах — по времени Сургута, где бы ни запускались

// Юнит-тесты фронта: только src/**/*.test.ts (e2e на Playwright — в e2e/, запускаются отдельно: npm run e2e)
export default defineConfig({ test: { include: ["src/**/*.test.ts"], environment: "node" } });
