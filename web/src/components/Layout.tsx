import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../api/auth.tsx";
import { animateThemeChange, useInk } from "./ui/motion.ts";
import { useApi } from "../api/hooks.ts";
import { PasswordModal } from "./UserForms.tsx";
import { alertOf, connectStream, onStream } from "../api/stream.ts";
import type { Notifications } from "../api/types.ts";

type Toast = { id: number; level: "red" | "yellow" | "green"; text: string };

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const t = localStorage.getItem("theme");
      if (t === "dark" || t === "light") return t;
    } catch {
      /* нет доступа */
    }
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* нет доступа */
    }
  }, [theme]);
  // тема ставится на <html> сразу внутри перехода — снимок «после» уже в новых цветах
  const toggle = (from?: { x: number; y: number }) =>
    animateThemeChange(() => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      flushSync(() => setTheme(next));
    }, from);
  return [theme, toggle] as const;
}

const SEEN_KEY = "sam_seen_notices";
const readSeen = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
};
const LEVEL_ICON = { red: "●", yellow: "●", info: "○" } as const;

/** Колокольчик: все проблемы в одном месте (GET /api/notifications). «Новые» — те, что ещё не открывали. */
function Bell() {
  const n = useApi<Notifications>("/api/notifications", true, ["install", "license", "process"]);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(readSeen);
  const box = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  // перешли на другую страницу — закрыть список (состояние меняется при рендере, без эффекта)
  const [openedAt, setOpenedAt] = useState(loc.pathname);
  if (openedAt !== loc.pathname) {
    setOpenedAt(loc.pathname);
    setOpen(false);
  }
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const items = n.data?.items ?? [];
  const important = items.filter((i) => i.level !== "info");
  const unread = important.filter((i) => !seen.has(i.id + i.text)).length;
  const red = n.data?.counts.red ?? 0;
  const toggle = () => {
    if (!open) {
      const s = new Set(items.map((i) => i.id + i.text));
      setSeen(s);
      try {
        localStorage.setItem(SEEN_KEY, JSON.stringify([...s]));
      } catch {
        /* нет доступа */
      }
    }
    setOpen(!open);
  };

  return (
    <div className="bell-box" ref={box}>
      <button
        className={`bell ${red ? "has-red" : ""}`}
        onClick={toggle}
        aria-label={`Уведомления: ${important.length}`}
        title="Проблемы и предупреждения"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {important.length > 0 && <span className={`bell-n ${unread ? "" : "read"}`}>{unread || important.length}</span>}
      </button>
      {open && (
        <div className="bell-pop" role="dialog" aria-label="Уведомления">
          <div className="bell-head">
            <b>Уведомления</b>
            <span className="muted">
              {n.data ? (
                <>
                  <span className="red">{n.data.counts.red} важных</span> ·{" "}
                  <span className="amber">{n.data.counts.yellow} внимание</span>
                </>
              ) : (
                "…"
              )}
            </span>
          </div>
          <div className="bell-list">
            {items.map((i) => {
              const body = (
                <>
                  <span className={`lvl ${i.level}`}>{LEVEL_ICON[i.level]}</span>
                  <span className="txt">
                    <b>{i.title}</b>
                    <span>{i.text}</span>
                  </span>
                </>
              );
              return i.link ? (
                <Link key={i.id} to={i.link} className={`bell-item ${i.level}`}>
                  {body}
                  <span className="go">›</span>
                </Link>
              ) : (
                <div key={i.id} className={`bell-item ${i.level}`}>
                  {body}
                </div>
              );
            })}
            {!items.length && <div className="empty">Проблем нет</div>}
          </div>
          <div className="bell-foot">
            <Link to="/events?problems=1">Лента проблемных событий</Link>
            <Link to="/assistant">Спросить ассистента ✦</Link>
          </div>
        </div>
      )}
    </div>
  );
}

/** Меню пользователя: имя, роль, смена пароля, выход. */
function UserMenu() {
  const { user, isAdmin, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const initials = (user.name || user.login)
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="bell-box" ref={box}>
      <button
        className="user-btn"
        onClick={() => setOpen(!open)}
        aria-label={`Пользователь ${user.login}`}
        title={user.login}
      >
        {initials}
      </button>
      {open && (
        <div className="bell-pop user-pop" role="menu">
          <div className="bell-head">
            <span>
              <b>{user.name || user.login}</b>
              <br />
              <span className="muted mono">{user.login}</span>
            </span>
            <span className={`badge ${isAdmin ? "blue" : ""}`}>{isAdmin ? "администратор" : "только просмотр"}</span>
          </div>
          {user.id > 0 && (
            <button
              className="menu-item"
              onClick={() => {
                setPw(true);
                setOpen(false);
              }}
            >
              Сменить пароль
            </button>
          )}
          {isAdmin && (
            <Link className="menu-item" to="/settings/users" onClick={() => setOpen(false)}>
              Пользователи
            </Link>
          )}
          <button className="menu-item danger" onClick={logout}>
            Выйти
          </button>
        </div>
      )}
      {pw && (
        <PasswordModal
          mode="own"
          user={user}
          onClose={() => setPw(false)}
          onDone={() => {
            void logout();
          }}
        />
      )}
    </div>
  );
}

export default function Layout() {
  const [theme, toggle] = useTheme();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nav = useRef<HTMLElement>(null);
  useInk(nav, useLocation().pathname);

  useEffect(() => {
    connectStream();
    let n = 0;
    const offs = ["install", "license", "process", "command"].map((type) =>
      onStream(type, (m) => {
        const a = alertOf(type, m);
        if (!a) return;
        const id = ++n;
        setToasts((t) => [...t.slice(-3), { id, ...a }]);
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000);
      }),
    );
    return () => offs.forEach((o) => o());
  }, []);

  return (
    <>
      <header className="topbar">
        <span className="brand">EasySAM</span>
        <nav className="ink" ref={nav}>
          <NavLink to="/dashboard">Дашборд</NavLink>
          <NavLink to="/agents">Рабочие места</NavLink>
          <NavLink to="/catalog">Каталог ПО</NavLink>
          <NavLink to="/purchases">Закупки</NavLink>
          <NavLink to="/events">Лента событий</NavLink>
          <NavLink to="/settings">Настройки</NavLink>
        </nav>
        <span className="spacer" />
        <NavLink to="/assistant" className="ai-link">
          <span className="ai-txt">ИИ-ассистент </span>✦
        </NavLink>
        <Bell />
        <button
          className="theme-btn"
          onClick={(e) => {
            const b = e.currentTarget.getBoundingClientRect();
            toggle({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
          }}
          aria-label={theme === "light" ? "Тема: светлая" : "Тема: тёмная"}
        >
          {theme === "light" ? "☀" : "☾"}
          <span className="theme-txt">{theme === "light" ? " Светлая" : " Тёмная"}</span>
        </button>
        <UserMenu />
      </header>
      <Outlet />
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>
  );
}
