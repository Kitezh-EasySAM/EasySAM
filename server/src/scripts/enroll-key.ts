/**
 * `make enroll-key TITLE="Бухгалтерия" USES=50 [DAYS=30]`: выдать ключ регистрации агентов (для install-sam-agent.ps1).
 * Ключ показывается ОДИН раз — на сервере хранится только хеш. С ADMIN_TOKEN — через API (SAM_URL, по умолч.
 *   http://localhost:8000), без него — прямо в БД (DB_PATH).
 */
const base = process.env.SAM_URL ?? "http://localhost:8000";
const days = Number(process.env.DAYS) || 0;
const body = {
  title: process.env.TITLE || "Установка агентов",
  ...(process.env.USES ? { max_uses: Number(process.env.USES) } : {}),
  ...(days ? { expires_at: new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10) } : {}),
};
// ADMIN_TOKEN задан — через API работающего сервера; нет — прямо в БД (DB_PATH), как make user
let d: { key?: string; error?: string; title?: string; max_uses?: number | null; expires_at?: string | null };
if (process.env.ADMIN_TOKEN) {
  const r = await fetch(`${base}/api/agent-enroll-keys`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${process.env.ADMIN_TOKEN}` },
    body: JSON.stringify(body),
  }).catch((e) => {
    console.error(`нет связи с ${base}: ${e.message}`);
    process.exit(1);
  });
  d = (await r.json()) as typeof d;
  if (!r.ok || !d.key) {
    console.error(`ошибка ${r.status}: ${d.error ?? JSON.stringify(d)}`);
    process.exit(1);
  }
} else {
  const { openDb } = await import("../db.ts");
  const { config } = await import("../config.ts");
  const { createEnrollKey } = await import("../services/agentAuth.ts");
  const { key } = createEnrollKey(openDb(config.dbPath), body);
  d = { key, ...body };
}
const host = new URL(base).hostname;
console.log(
  `Ключ регистрации «${d.title}»${d.max_uses ? `, до ${d.max_uses} ПК` : ""}${d.expires_at ? `, до ${d.expires_at}` : ""} (показывается один раз):\n`,
);
console.log(`  ${d.key}\n`);
console.log("На ПК — PowerShell от имени администратора, в папке с sam-agent.exe и install-sam-agent.ps1:\n");
console.log(
  `  powershell -ExecutionPolicy Bypass -File .\\install-sam-agent.ps1 -Server ${host === "localhost" || host === "127.0.0.1" ? "<IP-этого-сервера>" : host} -EnrollKey ${d.key}\n`,
);
