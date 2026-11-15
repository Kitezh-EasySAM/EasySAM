import { useState } from "react";
import { api, ApiError } from "../api/client.ts";
import { useApi } from "../api/hooks.ts";
import { dateRu } from "../format.ts";
import { Badge } from "./ui/index.ts";

interface Defaults {
  public_url: string | null;
  agent_exe: boolean;
}
interface EnrollKey {
  id: number;
  title: string;
  key_masked: string;
  max_uses: number | null;
  uses: number;
  expires_at: string | null;
  revoked: boolean;
  active_tokens: number;
  created_at: string;
}

const isLocal = (u: string) => /^(https?:\/\/)?(localhost|127\.|\[::1\])/i.test(u.trim());
const today = () => new Date().toISOString().slice(0, 10);

/**
 * «Рабочие места» → вкладка «Установка агента»: 1) скачать sam-agent.exe, 2) скачать sam-agent.json с только что
 * сгенерированным ключом регистрации (POST /api/agent-config, API §13), 3) запустить на ПК.
 * Ключ в открытом виде есть только в скачанном файле; агент по нему получит собственный токен ПК.
 */
export function AgentSetup() {
  const defaults = useApi<Defaults>("/api/agent-config/defaults", false);
  const keys = useApi<EnrollKey[]>("/api/agent-enroll-keys", false);
  const [title, setTitle] = useState(`ПК, ${dateRu(today())}`);
  const [server, setServer] = useState<string | null>(null);
  const [maxUses, setMaxUses] = useState("50");
  const [days, setDays] = useState("30");
  const [interval, setIntervalSec] = useState("60");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; server: string } | null>(null);

  const srv = server ?? defaults.data?.public_url ?? location.origin;
  const hasExe = defaults.data?.agent_exe;

  const generate = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/agent-config", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          server: srv.trim(),
          max_uses: maxUses ? +maxUses : null,
          days: days ? +days : null,
          interval: +interval || 60,
        }),
      });
      if (!r.ok)
        throw new ApiError(
          ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `Ошибка ${r.status}`,
          r.status,
        );
      const a = document.createElement("a");
      a.href = URL.createObjectURL(await r.blob());
      a.download = "sam-agent.json";
      a.click();
      URL.revokeObjectURL(a.href);
      setDone({ title: title.trim(), server: srv.trim() });
      keys.reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (k: EnrollKey) => {
    try {
      await api.del(`/api/agent-enroll-keys/${k.id}`);
      keys.reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const state = (k: EnrollKey) =>
    k.revoked ? (
      <Badge tone="red">отозван</Badge>
    ) : k.expires_at && k.expires_at < today() ? (
      <Badge tone="amber">истёк</Badge>
    ) : k.max_uses != null && k.uses >= k.max_uses ? (
      <Badge tone="amber">исчерпан</Badge>
    ) : (
      <Badge tone="green">действует</Badge>
    );

  return (
    <div className="setup">
      <div className="setup-steps">
        <div className="card">
          <div className="card-head">
            <h3>
              <span className="step-n">1</span>Скачать агента
            </h3>
          </div>
          <div className="setup-body">
            <p>Программа для Windows: собирает список установленного ПО, лицензии и запущенные программы.</p>
            {hasExe ? (
              <a className="btn primary" href="/downloads/sam-agent.exe" download>
                Скачать sam-agent.exe
              </a>
            ) : (
              <div className="hint amber">
                {defaults.loading
                  ? "…"
                  : "sam-agent.exe на сервере не найден — соберите: make agent-dist (в Docker он есть сразу)"}
              </div>
            )}
            <a className="setup-link" href="/downloads/install-sam-agent.ps1" download>
              install-sam-agent.ps1 — установка на много ПК
            </a>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>
              <span className="step-n">2</span>Скачать настройки агента
            </h3>
          </div>
          <div className="setup-body">
            <p>
              Файл <span className="mono">sam-agent.json</span>: адрес сервера и новый ключ регистрации. Ключ создаётся
              при скачивании.
            </p>
            <div className="form">
              <label className="field">
                <span>
                  Для кого (название ключа) <b className="req">*</b>
                </span>
                <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="field">
                <span>
                  Адрес сервера для ПК <b className="req">*</b>
                </span>
                <input className="input mono" value={srv} onChange={(e) => setServer(e.target.value)} />
                {isLocal(srv) && <span className="hint amber">По адресу localhost ПК не увидят сервер</span>}
              </label>
              <label className="field half">
                <span>Сколько ПК можно подключить</span>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={maxUses}
                  onChange={(e) => setMaxUses(e.target.value)}
                />
              </label>
              <label className="field half">
                <span>Ключ действует, дней</span>
                <input className="input" type="number" min={1} value={days} onChange={(e) => setDays(e.target.value)} />
              </label>
              <label className="field half">
                <span>Проверять ПО, раз в … с</span>
                <input
                  className="input"
                  type="number"
                  min={10}
                  value={interval}
                  onChange={(e) => setIntervalSec(e.target.value)}
                />
              </label>
            </div>
            {err && (
              <div className="uf-err" role="alert">
                {err}
              </div>
            )}
            <button className="btn primary" disabled={busy || !title.trim() || !srv.trim()} onClick={generate}>
              {busy ? "Создаю…" : "Скачать sam-agent.json"}
            </button>
            {done && (
              <div className="ca-done">
                <b>Файл sam-agent.json скачан</b>
                <span className="muted">
                  Ключ «{done.title}» → {done.server}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h3>
              <span className="step-n">3</span>Запустить на ПК
            </h3>
          </div>
          <div className="setup-body">
            <ol className="ca-steps">
              <li>
                Положите <span className="mono">sam-agent.exe</span> и <span className="mono">sam-agent.json</span> в
                одну папку.
              </li>
              <li>
                Запустите <span className="mono">sam-agent.exe</span> от имени администратора — встанет служба.
              </li>
              <li>ПК появится в списке «Рабочие места» примерно через минуту.</li>
            </ol>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Выданные ключи регистрации</h3>
        </div>
        {keys.data?.length ? (
          <table className="t">
            <thead>
              <tr>
                <th>Название</th>
                <th>Ключ</th>
                <th className="num">ПК</th>
                <th>До</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td>{k.title}</td>
                  <td className="mono muted">{k.key_masked}</td>
                  <td className="num">
                    {k.uses}
                    {k.max_uses != null ? ` / ${k.max_uses}` : ""}
                  </td>
                  <td>{k.expires_at ? dateRu(k.expires_at) : "без срока"}</td>
                  <td>{state(k)}</td>
                  <td className="right">
                    {!k.revoked && (
                      <button className="btn sm" onClick={() => revoke(k)}>
                        Отозвать
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">{keys.loading ? "…" : "Ключей ещё нет"}</div>
        )}
      </div>
    </div>
  );
}
