import { useState } from "react";
import { api } from "../api/client.ts";
import type { AppUser } from "../api/types.ts";
import { PasswordField } from "../components/UserForms.tsx";
import { passwordProblems } from "../passwordPolicy.ts";
import { focusOnMount } from "../components/ui/focus.ts";

/** Экран входа: логин и пароль → cookie-сессия (POST /api/auth/login). */
export default function Login({ onDone, notice }: { onDone: (u: AppUser) => void; notice?: string }) {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      onDone((await api.post<{ user: AppUser }>("/api/auth/login", { login: login.trim(), password })).user);
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
      setBusy(false);
      setPassword("");
    }
  };
  return (
    <div className="login-bg">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand">
          <span className="login-logo">E</span>
          <div>
            <b>EasySAM</b>
            <span>Учёт ПО и лицензий</span>
          </div>
        </div>
        <h1>Вход</h1>
        <label className="field">
          <span>Логин</span>
          <input
            className="input"
            ref={focusOnMount}
            autoComplete="username"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            required
            maxLength={100}
          />
        </label>
        <label className="field">
          <span>Пароль</span>
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            maxLength={200}
          />
        </label>
        {notice && !err && (
          <div className="login-ok" role="status">
            {notice}
          </div>
        )}
        {err && (
          <div className="login-err" role="alert">
            {err}
          </div>
        )}
        <button type="submit" className="btn primary" disabled={busy || !login.trim() || !password}>
          {busy ? "Вход…" : "Войти"}
        </button>
        <p className="faint">Нет учётной записи — обратитесь к администратору.</p>
      </form>
    </div>
  );
}

/** Первый вход с выданным паролем: сменить его обязательно (сервер до смены отвечает 403 на всё, кроме /api/auth/*). */
export function FirstPassword({ user, onDone, onCancel }: { user: AppUser; onDone: () => void; onCancel: () => void }) {
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const ctx = { login: user.login, name: user.name };
  const valid =
    current.length > 0 && !passwordProblems(password, ctx).length && confirm === password && password !== current;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setErr("");
    try {
      await api.post("/api/auth/password", { current_password: current, new_password: password });
      onDone();
    } catch (x) {
      setErr(x instanceof Error ? x.message : String(x));
      setBusy(false);
    }
  };
  return (
    <div className="login-bg">
      <form className="login-card wide" onSubmit={submit} noValidate>
        <div className="login-brand">
          <span className="login-logo">E</span>
          <div>
            <b>EasySAM</b>
            <span>Учёт ПО и лицензий</span>
          </div>
        </div>
        <h1>Смените пароль</h1>
        <p className="login-lead">
          Вы вошли как <b>{user.login}</b> с выданным паролем. Задайте свой — после этого откроется система.
        </p>
        <label className="field">
          <span>Текущий (выданный) пароль</span>
          <input
            className="input"
            type="password"
            ref={focusOnMount}
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            maxLength={200}
          />
        </label>
        <PasswordField value={password} onChange={setPassword} ctx={ctx} label="Новый пароль" own />
        <label className="field">
          <span>Повторите новый пароль</span>
          <input
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            maxLength={128}
            aria-invalid={!!confirm && confirm !== password}
          />
        </label>
        {password && password === current && <div className="login-err">Новый пароль совпадает с текущим</div>}
        {confirm && confirm !== password && <div className="login-err">Пароли не совпадают</div>}
        {err && (
          <div className="login-err" role="alert">
            {err}
          </div>
        )}
        <button type="submit" className="btn primary" disabled={busy || !valid}>
          {busy ? "Сохраняю…" : "Сменить пароль и войти"}
        </button>
        <button type="button" className="link-btn" onClick={onCancel}>
          Выйти
        </button>
      </form>
    </div>
  );
}
