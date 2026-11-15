import { useState } from "react";
import { PASSWORD_RULES, passwordProblems, passwordScore, randomPassword } from "../passwordPolicy.ts";
import { focusOnMount } from "./ui/focus.ts";

// Поля пароля для регистрации, смены и сброса: пароль с проверкой правил на лету и повтор пароля.
type Ctx = { login?: string | null; name?: string | null };
const SCORE = ["", "слабый", "слабый", "хороший", "надёжный"];

const TR: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};
/** «Иванов Иван Петрович» → «ivanov.i» */
export function loginFromName(name: string): string {
  const [last = "", first = ""] = name.trim().toLowerCase().split(/\s+/);
  const tr = (s: string) => [...s].map((c) => TR[c] ?? (/[a-z0-9]/.test(c) ? c : "")).join("");
  const l = tr(last),
    f = tr(first).slice(0, 1);
  return l ? (f ? `${l}.${f}` : l).slice(0, 32) : "";
}

/** Пароль с показом/скрытием, генератором, полоской надёжности и правилами с галочками. */
export function PasswordField({
  value,
  onChange,
  ctx,
  label = "Пароль",
  autoFocus,
  autoComplete = "new-password",
  own,
}: {
  value: string;
  onChange: (v: string) => void;
  ctx: Ctx;
  label?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  own?: boolean; // пароль задаёт себе сам пользователь (не администратор другому)
}) {
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);
  const problems = passwordProblems(value, ctx); // дёшево: несколько регулярных выражений
  const score = passwordScore(value, ctx);
  const generate = () => {
    const p = randomPassword();
    onChange(p);
    setShow(true);
    navigator.clipboard?.writeText(p).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      },
      () => {},
    );
  };
  return (
    <div className="pw-field">
      <div className="uf-label">
        <span>
          {label} <b className="req">*</b>
        </span>
        <button type="button" className="link-btn" onClick={generate}>
          {copied ? "Сгенерирован и скопирован ✓" : "Сгенерировать надёжный"}
        </button>
      </div>
      <div className="pw-input">
        <input
          className="input"
          type={show ? "text" : "password"}
          value={value}
          ref={autoFocus ? focusOnMount : undefined}
          autoComplete={autoComplete}
          maxLength={128}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!value && problems.length > 0}
          spellCheck={false}
        />
        <button
          type="button"
          className="pw-eye"
          onClick={() => setShow(!show)}
          aria-label={show ? "Скрыть пароль" : "Показать пароль"}
        >
          {show ? "Скрыть" : "Показать"}
        </button>
      </div>
      <div className={`pw-meter s${score}`} aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="pw-score">
        {value ? (
          <>
            Надёжность: <b>{SCORE[score]}</b>
          </>
        ) : own ? (
          ""
        ) : (
          "Пароль задаёт администратор и передаёт пользователю лично"
        )}
      </div>
      <ul className="pw-rules">
        {PASSWORD_RULES.map((r) => {
          const bad = problems.includes(r);
          return (
            <li key={r} className={!value ? "" : bad ? "bad" : "ok"}>
              {!value ? "○" : bad ? "✕" : "✓"} {r}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ConfirmField({
  value,
  onChange,
  password,
}: {
  value: string;
  onChange: (v: string) => void;
  password: string;
}) {
  const state = !value ? "" : value === password ? "ok" : "bad";
  return (
    <label className="uf-field">
      <span className="uf-label">
        <span>
          Повторите пароль <b className="req">*</b>
        </span>
        {state && (
          <span className={state === "ok" ? "green" : "red"}>{state === "ok" ? "✓ совпадают" : "✕ не совпадают"}</span>
        )}
      </span>
      <input
        className="input"
        type="password"
        value={value}
        autoComplete="new-password"
        maxLength={128}
        onChange={(e) => onChange(e.target.value)}
        onPaste={(e) => e.preventDefault()}
        aria-invalid={state === "bad"}
      />
    </label>
  );
}
