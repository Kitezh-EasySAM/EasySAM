import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Погасить сервер e2e (по PID из global-setup) и удалить временную базу. */
export default async function globalTeardown() {
  const dir = process.env.SAM_E2E_DIR;
  if (!dir) return;
  try {
    process.kill(Number(readFileSync(join(dir, "pid"), "utf8")));
  } catch {
    /* сервер уже остановлен */
  }
  rmSync(dir, { recursive: true, force: true });
}
