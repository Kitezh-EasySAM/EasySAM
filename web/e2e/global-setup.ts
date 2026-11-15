import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "@playwright/test";
import { BASE } from "./playwright.config.ts";

const ROOT = resolve(import.meta.dirname, "../..");
export const PASSWORDS = { admin: "Kedr#Taiga-29", viewer: "Sosna!Reka-47" };
/** Пароль, который admin выдаёт viewer; при первом входе viewer меняет его на PASSWORDS.viewer. */
const VIEWER_ISSUED = `${PASSWORDS.viewer}-new`;

/** Временная демо-база → сервер на 8190 с собранным фронтом → пароли сменены → вход admin и viewer сохранён. */
export default async function globalSetup() {
  const dir = mkdtempSync(join(tmpdir(), "sam-e2e-"));
  const db = join(dir, "sam.db");
  const env = {
    ...process.env,
    DB_PATH: db,
    PORT: "8190",
    WEB_DIST: join(ROOT, "web/dist"),
    AGENT_DIST: "",
    INGEST_TOKEN: "",
  };
  execFileSync(process.execPath, ["src/scripts/run-seed.ts", "--demo"], {
    cwd: join(ROOT, "server"),
    env,
    stdio: "ignore",
  });
  const server = spawn(process.execPath, ["src/index.ts"], {
    cwd: join(ROOT, "server"),
    env,
    stdio: "ignore",
    detached: true,
  });
  writeFileSync(join(dir, "pid"), String(server.pid));
  process.env.SAM_E2E_DIR = dir;
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`${BASE}/api/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  mkdirSync(join(import.meta.dirname, ".auth"), { recursive: true });
  const login = async (who: "admin" | "viewer", first: string) => {
    const ctx = await request.newContext({ baseURL: BASE });
    const post = (url: string, data: object) => ctx.post(url, { data, headers: { origin: BASE } });
    await post("/api/auth/login", { login: who, password: first });
    if (first !== PASSWORDS[who]) {
      await post("/api/auth/password", { current_password: first, new_password: PASSWORDS[who] });
      await post("/api/auth/login", { login: who, password: PASSWORDS[who] });
    }
    return ctx;
  };
  const admin = await login("admin", "admin");
  await admin.post("/api/users", {
    data: { login: "viewer", name: "Зрителев Пётр", role: "viewer", password: VIEWER_ISSUED },
    headers: { origin: BASE },
  });
  await admin.storageState({ path: join(import.meta.dirname, ".auth/admin.json") });
  const viewer = await login("viewer", VIEWER_ISSUED);
  await viewer.storageState({ path: join(import.meta.dirname, ".auth/viewer.json") });
}
