/**
 * Вход в интерфейс и пользователи. Логика: services/users.ts, проверка доступа: routes/auth.ts. Контракт:
 *   docs/API.md «Доступ», §18
 *   POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me, POST /api/auth/password
 *   GET/POST /api/users, PATCH/DELETE /api/users/:id (только admin — проверяет auth.ts)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB } from "../db.ts";
import {
  activeAdmins,
  checkPasswordStrength,
  createUser,
  loginProblem,
  nameProblem,
  getUser,
  listUsers,
  login,
  logout,
  setPassword,
  verifyPassword,
} from "../services/users.ts";
import { currentUser, readCookie, SESSION_COOKIE, setSessionCookie } from "./auth.ts";
import { body, parseId } from "./util.ts";

const loginBody = z.object({ login: z.string().trim().min(1).max(100), password: z.string().min(1).max(200) });
const role = z.enum(["admin", "viewer"]);
const createBody = z.strictObject({
  login: z.string().trim().toLowerCase().max(32),
  name: z.string().trim().max(200),
  password: z.string().min(1).max(200),
  password_confirm: z.string().max(200).optional(),
  role,
});
const patchBody = z
  .strictObject({
    name: z.string().trim().max(200).nullable(),
    role,
    active: z.boolean(),
    password: z.string().min(1).max(200),
  })
  .partial();
const passwordBody = z.strictObject({
  current_password: z.string().min(1).max(200),
  new_password: z.string().min(1).max(200),
});

export function userRoutes(app: FastifyInstance, db: DB) {
  app.post("/api/auth/login", async (req, reply) => {
    const d = body(loginBody, req.body, reply);
    if (!d) return;
    const r = login(db, d.login, d.password, req.ip);
    if (r && "locked" in r)
      return reply
        .code(429)
        .header("retry-after", r.locked)
        .send({ error: `слишком много попыток — подождите ${Math.ceil(r.locked / 60)} мин` });
    if (!r) return reply.code(401).send({ error: "неверный логин или пароль" });
    setSessionCookie(reply, r.token);
    return { user: r.user };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    logout(db, readCookie(req, SESSION_COOKIE));
    setSessionCookie(reply, null);
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (req) => ({ user: currentUser(req) }));

  app.post("/api/auth/password", async (req, reply) => {
    const me = currentUser(req);
    const d = body(passwordBody, req.body, reply);
    if (!d) return;
    if (!me?.id) return reply.code(400).send({ error: "пароль меняется только у пользователя, вошедшего по логину" });
    const row = db.prepare("SELECT password_hash FROM app_user WHERE id = ?").get(me.id) as { password_hash: string };
    if (!verifyPassword(d.current_password, row.password_hash))
      return reply.code(400).send({ error: "текущий пароль неверный" });
    const weak = checkPasswordStrength(d.new_password, { login: me.login, name: me.name });
    if (!weak && d.new_password === d.current_password)
      return reply.code(400).send({ error: "новый пароль совпадает с текущим" });
    if (weak) return reply.code(400).send({ error: weak });
    setPassword(db, me.id, d.new_password); // все сессии сброшены — войти заново
    setSessionCookie(reply, null);
    return reply.code(204).send();
  });

  // ---- управление пользователями (только admin: viewer не пройдёт onRequest на запись; GET закрываем здесь)
  const adminOnly = (req: Parameters<typeof currentUser>[0]) => currentUser(req)?.role === "admin";

  app.get("/api/users", async (req, reply) =>
    adminOnly(req) ? listUsers(db) : reply.code(403).send({ error: "только для администратора" }),
  );

  app.post("/api/users", async (req, reply) => {
    const d = body(createBody, req.body, reply);
    if (!d) return;
    const problem =
      loginProblem(d.login) ??
      nameProblem(d.name) ??
      (d.password_confirm !== undefined && d.password_confirm !== d.password ? "пароли не совпадают" : null) ??
      checkPasswordStrength(d.password, { login: d.login, name: d.name });
    if (problem) return reply.code(400).send({ error: problem });
    if (db.prepare("SELECT 1 FROM app_user WHERE login = ?").get(d.login))
      return reply.code(409).send({ error: `логин «${d.login}» уже занят` });
    const id = createUser(db, { login: d.login, name: d.name, password: d.password, role: d.role, mustChange: true }); // пароль выдал администратор
    return reply.code(201).send(getUser(db, id));
  });

  app.patch<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const d = body(patchBody, req.body, reply);
    if (!d) return;
    const u = id ? getUser(db, id) : null;
    if (!u) return reply.code(404).send({ error: "не найдено" });
    const losingAdmin = u.role === "admin" && u.active && (d.role === "viewer" || d.active === false);
    if (losingAdmin && activeAdmins(db) <= 1)
      return reply.code(409).send({ error: "нельзя оставить систему без администратора" });
    if (d.password !== undefined) {
      const weak = checkPasswordStrength(d.password, { login: u.login, name: d.name ?? u.name });
      if (weak) return reply.code(400).send({ error: weak });
      setPassword(db, u.id, d.password, u.id !== currentUser(req)?.id); // чужой пароль сброшен — владелец сменит при входе
    }
    if (d.name !== undefined) {
      const bad = nameProblem(d.name);
      if (bad) return reply.code(400).send({ error: bad });
    }
    if (d.name !== undefined) db.prepare("UPDATE app_user SET name = ? WHERE id = ?").run(d.name, u.id);
    if (d.role) db.prepare("UPDATE app_user SET role = ? WHERE id = ?").run(d.role, u.id);
    if (d.active !== undefined) {
      db.prepare("UPDATE app_user SET active = ? WHERE id = ?").run(d.active ? 1 : 0, u.id);
      if (!d.active) db.prepare("DELETE FROM user_session WHERE user_id = ?").run(u.id);
    }
    return getUser(db, u.id);
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", async (req, reply) => {
    const id = parseId(req.params.id);
    const u = id ? getUser(db, id) : null;
    if (!u) return reply.code(404).send({ error: "не найдено" });
    if (u.id === currentUser(req)?.id) return reply.code(409).send({ error: "нельзя удалить самого себя" });
    if (u.role === "admin" && u.active && activeAdmins(db) <= 1)
      return reply.code(409).send({ error: "нельзя удалить последнего администратора" });
    db.prepare("DELETE FROM app_user WHERE id = ?").run(u.id);
    return reply.code(204).send();
  });
}
