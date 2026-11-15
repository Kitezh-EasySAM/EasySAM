import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import Login, { FirstPassword } from "../pages/Login.tsx";
import { api, UNAUTHORIZED } from "./client.ts";
import { disconnectStream } from "./stream.ts";
import type { AppUser } from "./types.ts";

interface Auth {
  user: AppUser;
  isAdmin: boolean;
  logout: () => Promise<void>;
}
const Ctx = createContext<Auth | null>(null);

/** Пускает в интерфейс только после входа; 401 от любого запроса возвращает на экран входа. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null | undefined>(undefined);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    api.get<{ user: AppUser | null }>("/api/auth/me").then(
      (r) => setUser(r.user),
      () => setUser(null),
    );
    const out = () => {
      disconnectStream();
      setUser(null);
    };
    window.addEventListener(UNAUTHORIZED, out);
    return () => window.removeEventListener(UNAUTHORIZED, out);
  }, []);

  // роль на <html>: кнопки изменения (.admin-only) у «только просмотр» скрыты, поля (.admin-edit) не редактируются
  useEffect(() => {
    document.documentElement.dataset.role = user?.role ?? "";
  }, [user]);

  if (user === undefined)
    return (
      <div className="login-bg">
        <div className="muted">Загрузка…</div>
      </div>
    );
  if (!user)
    return (
      <Login
        notice={notice}
        onDone={(u) => {
          setNotice("");
          setUser(u);
        }}
      />
    );
  // пароль выдан (первый вход admin, создан или сброшен администратором) — дальше не пускаем, пока не сменит
  if (user.must_change_password)
    return (
      <FirstPassword
        user={user}
        onDone={() => {
          setNotice("Пароль изменён — войдите с новым паролем");
          setUser(null);
        }}
        onCancel={() => {
          api.post("/api/auth/logout", {}).catch(() => {});
          setUser(null);
        }}
      />
    );
  const logout = async () => {
    await api.post("/api/auth/logout", {}).catch(() => {});
    disconnectStream();
    try {
      sessionStorage.removeItem("sam_chat");
    } catch {
      /* нет доступа */
    } // история чата (ФИО в ответах) — не следующему пользователю
    setUser(null);
  };
  return <Ctx.Provider value={{ user, isAdmin: user.role === "admin", logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): Auth {
  const a = useContext(Ctx);
  if (!a) throw new Error("useAuth вне AuthGate");
  return a;
}
