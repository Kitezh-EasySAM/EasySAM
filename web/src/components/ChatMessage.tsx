import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { ChatAnswer } from "../api/types.ts";
import { EulaResult } from "./Eula.tsx";
import { thinkingLabel } from "../format.ts";

/** Сообщение переписки с ассистентом (вопрос пользователя или ответ). */
export type Msg = { id: number; role: "user" | "bot"; text: string; data?: ChatAnswer; error?: boolean; at: number };

/** Простая разметка ответа: строки «• …» / «- …» — список, **жирный**. */
function Rich({ text }: { text: string }) {
  const bold = (s: string) =>
    s
      .split(/(\*\*[^*]+\*\*)/)
      .map((p, i) =>
        p.startsWith("**") && p.endsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : <Fragment key={i}>{p}</Fragment>,
      );
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length)
      out.push(
        <ul key={`l${out.length}`}>
          {list.map((l, i) => (
            <li key={i}>{bold(l)}</li>
          ))}
        </ul>,
      );
    list = [];
  };
  for (const line of text.split("\n")) {
    const m = /^(?:[•\-*]|\d+[.)])\s(.*)$/.exec(line.trimStart());
    if (m) list.push(m[1].trimStart());
    else {
      flush();
      if (line.trim()) out.push(<p key={`p${out.length}`}>{bold(line)}</p>);
    }
  }
  flush();
  return <div className="ai-rich">{out}</div>;
}

export function BotMsg({ m, onAsk }: { m: Msg; onAsk: (q: string) => void }) {
  const a = m.data;
  const [all, setAll] = useState(false);
  const [copied, setCopied] = useState(false);
  const rows = a?.table?.rows ?? [];
  const shown = all ? rows : rows.slice(0, 12);
  const copy = () => {
    const tsv = a?.table
      ? `\n\n${[a.table.columns, ...a.table.rows].map((r) => r.map((v) => v ?? "").join("\t")).join("\n")}`
      : "";
    navigator.clipboard?.writeText(m.text + tsv).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };
  return (
    <div className="ai-msg bot">
      <div className="ai-avatar">✦</div>
      <div className={`ai-bubble ${m.error ? "error" : ""}`}>
        {a?.eula ? <p className="ai-lead">{a.eula.verdict_text}</p> : <Rich text={m.text} />}
        {a?.eula && <EulaResult a={a.eula} />}
        {a?.table && rows.length > 0 && (
          <div className="ai-table">
            <table className="t">
              <thead>
                <tr>
                  {a.table.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    {r.map((v, j) => (
                      <td key={j}>{v ?? "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 12 && (
              <button className="link-btn" onClick={() => setAll(!all)}>
                {all ? "Свернуть" : `Показать все ${rows.length} строк`}
              </button>
            )}
          </div>
        )}
        {a?.links && a.links.length > 0 && !a.eula && (
          <div className="ai-links">
            {a.links.map((l) => (
              <Link key={l.href} to={l.href}>
                {l.label} →
              </Link>
            ))}
          </div>
        )}
        {a?.sql && (
          <details className="ai-sql">
            <summary>SQL-запрос к базе</summary>
            <pre>{a.sql}</pre>
          </details>
        )}
        <div className="ai-foot">
          <span>{new Date(m.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>
          {a?.source === "llm" && <span>· ИИ-модель</span>}
          {!m.error && (
            <button className="link-btn" onClick={copy}>
              {copied ? "Скопировано" : "Копировать"}
            </button>
          )}
        </div>
        {a?.suggestions && a.suggestions.length > 0 && (
          <div className="ai-chips">
            {a.suggestions.map((s) => (
              <button key={s} className="ai-chip" onClick={() => onAsk(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Ассистент думает: светящийся аватар, прыгающие точки и подпись со счётчиком секунд (локальная модель отвечает долго). */
export function ThinkingMsg() {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setSec(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="ai-msg bot" role="status" aria-live="polite">
      <div className="ai-avatar thinking">
        <span>✦</span>
      </div>
      <div className="ai-bubble typing">
        <i />
        <i />
        <i />
        <span className="ai-think-text">{thinkingLabel(sec)}</span>
      </div>
    </div>
  );
}
