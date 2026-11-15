/**
 * `make user LOGIN=ivanov [ROLE=admin|viewer] [NAME="Иванов И."] [PASSWORD=…]` — создать пользователя интерфейса
 * или сбросить пароль существующему (все его сессии завершаются). Без PASSWORD — случайный, печатается один раз.
 * Пишет прямо в БД (DB_PATH из .env), сервер можно не останавливать.
 */
import { config } from "../config.ts";
import { openDb } from "../db.ts";
import { checkPasswordStrength, createUser, loginProblem, randomPassword, setPassword } from "../services/users.ts";

const login = (process.env.LOGIN ?? "").trim().toLowerCase();
if (!login) {
  console.error("укажите LOGIN: make user LOGIN=ivanov [ROLE=viewer|admin] [PASSWORD=…]");
  process.exit(1);
}
const role =
  process.env.ROLE === "admin" ? "admin" : process.env.ROLE === "viewer" || !process.env.ROLE ? "viewer" : null;
if (!role) {
  console.error("ROLE: admin или viewer");
  process.exit(1);
}
const password = process.env.PASSWORD || randomPassword();
const weak = checkPasswordStrength(password, { login, name: process.env.NAME });
if (weak) {
  console.error(weak);
  process.exit(1);
}

const db = openDb(config.dbPath);
const ex = db.prepare("SELECT id, role FROM app_user WHERE login = ?").get(login) as
  { id: number; role: string } | undefined;
if (!ex && loginProblem(login)) {
  console.error(loginProblem(login));
  process.exit(1);
}
if (ex) {
  setPassword(db, ex.id, password);
  db.prepare("UPDATE app_user SET active = 1 WHERE id = ?").run(ex.id);
  if (process.env.ROLE) db.prepare("UPDATE app_user SET role = ? WHERE id = ?").run(role, ex.id);
  console.log(`Пароль пользователя «${login}» сброшен${process.env.ROLE ? `, роль: ${role}` : ""}.`);
} else {
  createUser(db, { login, password, role, name: process.env.NAME ?? null });
  console.log(`Создан пользователь «${login}», роль: ${role}.`);
}
console.log(process.env.PASSWORD ? "Пароль — заданный в PASSWORD." : `Пароль (показывается один раз): ${password}`);
