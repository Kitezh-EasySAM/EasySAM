import { buildApp } from "./app.ts";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { ensureFirstAdmin } from "./services/users.ts";

if (config.ingestToken === "dev-token")
  console.warn(
    "⚠ INGEST_TOKEN = dev-token — общеизвестное значение, для реальной сети уберите его (агенты подключаются ключом регистрации)",
  );
if (config.authMode === "off") console.warn("⚠ AUTH=off — интерфейс открыт всем в сети без входа (только для отладки)");
if (!config.requireDeviceToken && config.ingestToken)
  console.warn(
    "⚠ агенты принимаются и по общему INGEST_TOKEN (для боевой сети: уберите INGEST_TOKEN или REQUIRE_DEVICE_TOKEN=1)",
  );
const db = openDb(config.dbPath);
const first = ensureFirstAdmin(db);
if (first)
  console.log(
    `★ Создан пользователь «${first.login}», ${first.password ? `пароль: ${first.password}` : "пароль из ADMIN_PASSWORD"}` +
      " — временный, при первом входе система попросит сменить",
  );
{
  const { verifyPassword } = await import("./services/users.ts");
  const a = db.prepare("SELECT password_hash FROM app_user WHERE login = 'admin' AND active = 1").get() as
    { password_hash: string } | undefined;
  // база, созданная до появления обязательной смены: пароль «admin» остался — потребовать смену при входе
  if (a && verifyPassword("admin", a.password_hash))
    db.prepare("UPDATE app_user SET must_change_password = 1 WHERE login = 'admin'").run();
}
const app = await buildApp(db);
await app.listen({ port: config.port, host: "0.0.0.0" });
console.log(`EasySAM: http://localhost:${config.port}/api/health`);
