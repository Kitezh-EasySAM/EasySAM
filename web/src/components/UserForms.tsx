import { useId, useState } from "react";
import { api } from "../api/client.ts";
import type { AppUser } from "../api/types.ts";
import { loginProblem, nameProblem, passwordProblems } from "../passwordPolicy.ts";
import { ConfirmField, loginFromName, PasswordField } from "./PasswordFields.tsx";
import { Modal } from "./ui/index.ts";
import { focusOnMount } from "./ui/focus.ts";

export { PasswordField } from "./PasswordFields.tsx";
/** Регистрация пользователя (только администратор): строгие проверки на лету, кнопка активна, только когда всё верно. */
export function NewUserModal({
  users,
  onClose,
  onCreated,
}: {
  users: AppUser[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [loginTouched, setLoginTouched] = useState(false);
  const [role, setRole] = useState<"admin" | "viewer" | "">("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [handOver, setHandOver] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const effLogin = (loginTouched ? login : loginFromName(name)).trim().toLowerCase();
  const taken = users.some((u) => u.login.toLowerCase() === effLogin);
  const errors = {
    name: nameProblem(name),
    login: !effLogin ? "введите логин" : (loginProblem(effLogin) ?? (taken ? `логин «${effLogin}» уже занят` : null)),
    role: role ? null : "выберите роль",
    password: passwordProblems(password, { login: effLogin, name }).length ? "пароль не соответствует правилам" : null,
    confirm: confirm && confirm === password ? null : "пароли должны совпадать",
    handOver: handOver ? null : "подтвердите",
  };
  const valid = Object.values(errors).every((e) => !e);
  const show = (k: keyof typeof errors) =>
    touched[k] && errors[k] ? <span className="uf-err">{errors[k]}</span> : null;
  const touch = (k: string) => setTouched((t) => ({ ...t, [k]: true }));

  const submit = async () => {
    setTouched({ name: true, login: true, role: true, password: true, confirm: true, handOver: true });
    if (!valid) return;
    setBusy(true);
    setErr("");
    try {
      await api.post("/api/users", {
        login: effLogin,
        name: name.trim().replace(/\s+/g, " "),
        role,
        password,
        password_confirm: confirm,
      });
      onCreated();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal title="Регистрация пользователя" wide onClose={onClose}>
      <form
        className="uf"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        <label className="uf-field">
          <span className="uf-label">
            <span>
              Фамилия Имя Отчество <b className="req">*</b>
            </span>
          </span>
          <input
            className="input"
            ref={focusOnMount}
            value={name}
            maxLength={200}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => touch("name")}
            aria-invalid={touched.name && !!errors.name}
          />
          {show("name")}
        </label>
        <label className="uf-field">
          <span className="uf-label">
            <span>
              Логин <b className="req">*</b>
            </span>
            {effLogin && !errors.login && <span className="green">✓ свободен</span>}
          </span>
          <input
            className="input mono"
            value={loginTouched ? login : loginFromName(name)}
            maxLength={32}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setLogin(e.target.value.toLowerCase());
              setLoginTouched(true);
            }}
            onBlur={() => touch("login")}
            aria-invalid={touched.login && !!errors.login}
          />
          {show("login")}
        </label>

        <fieldset className="uf-roles">
          <legend>
            Роль <b className="req">*</b>
          </legend>
          {(
            [
              ["viewer", "Только просмотр", "Видит все данные и спрашивает ассистента. Ничего не меняет."],
              [
                "admin",
                "Администратор",
                "Меняет каталог, закупки, сотрудников, раздаёт ключи, управляет пользователями.",
              ],
            ] as const
          ).map(([v, t, d]) => (
            <label key={v} className={`uf-role ${role === v ? "on" : ""} ${v}`}>
              <input
                type="radio"
                name="role"
                value={v}
                checked={role === v}
                onChange={() => {
                  setRole(v);
                  touch("role");
                }}
              />
              <b>{t}</b>
              <span>{d}</span>
            </label>
          ))}
          {show("role")}
        </fieldset>

        <PasswordField
          value={password}
          onChange={(v) => {
            setPassword(v);
            touch("password");
          }}
          ctx={{ login: effLogin, name }}
        />
        <ConfirmField
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            touch("confirm");
          }}
          password={password}
        />

        <label className="uf-check">
          <input
            type="checkbox"
            checked={handOver}
            onChange={(e) => {
              setHandOver(e.target.checked);
              touch("handOver");
            }}
          />
          <span>Передам пароль лично (не по почте и не в чате) и попрошу сменить его после первого входа</span>
        </label>
        {show("handOver")}

        {err && <div className="err flush">{err}</div>}
        <div className="actions">
          <span className="muted small push-right">
            {valid ? "Всё заполнено верно" : `Осталось: ${Object.values(errors).filter(Boolean).length}`}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" disabled={busy || !valid}>
            {busy ? "Создаю…" : "Зарегистрировать"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Смена своего пароля (own) или сброс чужого администратором (reset) — по тем же правилам. */
export function PasswordModal({
  mode,
  user,
  onClose,
  onDone,
}: {
  mode: "own" | "reset";
  user: AppUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [current, setCurrent] = useState("");
  const currentId = useId();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ctx = { login: user.login, name: user.name };
  const valid =
    (mode === "reset" || current.length > 0) &&
    !passwordProblems(password, ctx).length &&
    confirm === password &&
    password !== current;
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setErr("");
    try {
      if (mode === "own") await api.post("/api/auth/password", { current_password: current, new_password: password });
      else await api.patch(`/api/users/${user.id}`, { password });
      onDone();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={mode === "own" ? "Смена пароля" : `Новый пароль для «${user.login}»`} wide onClose={onClose}>
      <form
        className="uf"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        {mode === "own" && (
          <div className="uf-field">
            <label className="uf-label" htmlFor={currentId}>
              <span>
                Текущий пароль <b className="req">*</b>
              </span>
            </label>
            <input
              id={currentId}
              className="input"
              type="password"
              ref={focusOnMount}
              value={current}
              autoComplete="current-password"
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
        )}
        <PasswordField
          value={password}
          onChange={setPassword}
          ctx={ctx}
          label="Новый пароль"
          autoFocus={mode === "reset"}
        />
        <ConfirmField value={confirm} onChange={setConfirm} password={password} />
        {password && password === current && <span className="uf-err">Новый пароль совпадает с текущим</span>}
        {err && <div className="err flush">{err}</div>}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="submit" className="btn primary" disabled={busy || !valid}>
            {busy ? "Сохраняю…" : "Сменить пароль"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
