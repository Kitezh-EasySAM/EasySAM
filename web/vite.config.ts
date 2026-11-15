import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // changeOrigin: false — сервер видит исходный Host и сверяет его с Origin (защита от CSRF, server/src/routes/auth.ts)
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ["/api", "/downloads"].map((p) => [
        p,
        { target: process.env.API_URL ?? "http://localhost:8000", changeOrigin: false },
      ]),
    ),
  },
});
