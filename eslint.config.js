// Линтер для сервера и фронта (flat config). Запуск: `npm run lint` (входит в `make check`).
// Без type-aware правил: сервер работает без сборки, линтеру не нужен tsconfig.
import js from "@eslint/js";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      ".venv/**",
      "tools/**",
      "web/dist/**",
      "agent/**",
      "материалы/**",
      "presentation/**",
      "web/test-results/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      eqeqeq: ["error", "smart"],
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    files: ["server/**/*.ts", "*.js", "web/*.ts", "web/e2e/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    // сервер пишет в консоль только при старте и в скриптах; остальное — через ответы API и ленту
    files: ["server/src/**/*.ts"],
    ignores: ["server/src/index.ts", "server/src/scripts/**"],
    rules: { "no-console": "error" },
  },
  {
    files: ["web/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks, "jsx-a11y": jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      // фокус ставится только в поле только что открытого окна или экрана входа — так и ожидается от диалога (WAI-ARIA APG)
      "jsx-a11y/no-autofocus": "off",
      // подпись поля бывает в двух вложенных span (текст + звёздочка «обязательно»)
      "jsx-a11y/label-has-associated-control": ["error", { depth: 4 }],
    },
  },
);
