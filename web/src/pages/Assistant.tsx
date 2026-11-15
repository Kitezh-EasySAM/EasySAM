import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client.ts";
import { useApi } from "../api/hooks.ts";
import type { ChatAnswer } from "../api/types.ts";
import { BotMsg, ThinkingMsg, type Msg } from "../components/ChatMessage.tsx";

interface Starter {
  title: string;
  value: string;
  level: "red" | "yellow" | "info";
  question: string;
}
interface Info {
  llm: boolean;
  provider: string | null;
  model: string | null;
  starters: Starter[];
}
const STORE = "sam_chat";
const load = (): Msg[] => {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? "[]");
  } catch {
    return [];
  }
};

/** ИИ-ассистент: одна колонка. Начало разговора — карточки из текущих данных (GET /api/ai/info → starters), не заготовленные примеры. */
export default function Assistant() {
  const info = useApi<Info>("/api/ai/info", false);
  const [msgs, setMsgs] = useState<Msg[]>(load);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => box.current?.focus(), []); // фокус в поле ввода при открытии (вместо autoFocus)

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(msgs.slice(-40)));
    } catch {
      /* нет доступа */
    }
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);
  useEffect(() => {
    // поле ввода растёт вместе с текстом
    const t = box.current;
    if (t) {
      t.style.height = "auto";
      t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
    }
  }, [q]);

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || busy) return;
    const id = Date.now();
    setMsgs((m) => [...m, { id, role: "user", text: question, at: id }]);
    setQ("");
    setBusy(true);
    try {
      const a = await api.post<ChatAnswer>("/api/ai/chat", { question });
      setMsgs((m) => [...m, { id: id + 1, role: "bot", text: a.answer, data: a, at: Date.now() }]);
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { id: id + 1, role: "bot", text: e instanceof Error ? e.message : String(e), error: true, at: Date.now() },
      ]);
    }
    setBusy(false);
    box.current?.focus();
  };

  // запрос из адреса (?q=…) — кнопки «Заполнить с ИИ» / «Добавить с ИИ»: отправить один раз и убрать из адреса
  const [params, setParams] = useSearchParams();
  const sent = useRef("");
  const askLatest = useRef(ask); // эффект ниже зависит только от адреса, а вызывает свежую ask
  useLayoutEffect(() => {
    askLatest.current = ask;
  });
  useEffect(() => {
    const fromUrl = params.get("q")?.trim();
    if (!fromUrl || sent.current === fromUrl) return;
    sent.current = fromUrl;
    setParams({}, { replace: true });
    void askLatest.current(fromUrl);
  }, [params, setParams]);

  const model = info.data?.llm ? `${prettyModel(info.data.model)}` : null;
  return (
    <div className="ai-shell">
      <section className="ai-main">
        {(msgs.length > 0 || model) && (
          <div className="ai-bar">
            <span className="ai-model">{model}</span>
            {msgs.length > 0 && (
              <button
                className="btn sm"
                onClick={() => {
                  setMsgs([]);
                  box.current?.focus();
                }}
              >
                Новый диалог
              </button>
            )}
          </div>
        )}
        <div className="ai-log" ref={log} aria-live="polite">
          {!msgs.length ? (
            <div className="ai-hello">
              <div className="ai-orb big">✦</div>
              <h1>Чем помочь?</h1>
              {!!info.data?.starters.length && (
                <div className="ai-topics">
                  {info.data.starters.map((t) => (
                    <button key={t.question} className="ai-topic" onClick={() => ask(t.question)} disabled={busy}>
                      <b className={`ai-topic-n ${t.level}`}>{t.value}</b>
                      <span>{t.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="ai-thread">
              {msgs.map((m) =>
                m.role === "user" ? (
                  <div key={m.id} className="ai-msg user">
                    <div className="ai-bubble">{m.text}</div>
                  </div>
                ) : (
                  <BotMsg key={m.id} m={m} onAsk={ask} />
                ),
              )}
              {busy && <ThinkingMsg />}
            </div>
          )}
        </div>
        <form
          className="ai-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(q);
          }}
        >
          <div className="ai-composer-box">
            <textarea
              ref={box}
              rows={1}
              value={q}
              maxLength={2000}
              placeholder="Сообщение"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void ask(q);
                }
              }}
            />
            <button type="submit" className="ai-send" disabled={!q.trim() || busy} aria-label="Отправить">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

const prettyModel = (m: string | null) =>
  (m ?? "")
    .replace(/^.*\//, "")
    .replace(/^qwen/i, "Qwen ")
    .replace(/-(\d+(\.\d+)?)b$/i, " $1B")
    .replace(/(\d)\.(\d)/, "$1.$2");
