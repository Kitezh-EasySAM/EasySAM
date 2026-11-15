import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../api/auth.tsx";
import { api } from "../api/client.ts";
import type { EulaAnalysis, LicenseKind } from "../api/types.ts";
import { KIND_LABEL } from "../format.ts";
import { focusOnMount } from "./ui/focus.ts";

const USE = {
  allowed: ["Разрешено", "green"],
  restricted: ["С ограничениями", "amber"],
  forbidden: ["Запрещено", "red"],
  unknown: ["Не ясно", ""],
} as const;
const VERDICT = {
  approve: ["Можно одобрить", "green", "✓"],
  review: ["Нужна проверка", "amber", "?"],
  reject: ["Нельзя без покупки", "red", "✕"],
} as const;
const yesNo = (v: boolean | null) => (v == null ? "—" : v ? "да" : "нет");

/** Поле «ссылка / название / текст» + результат проверки. */
export function EulaCheck({ autoFocus, onDone }: { autoFocus?: boolean; onDone?: () => void }) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<EulaAnalysis | null>(null);
  const run = async () => {
    if (!input.trim()) return;
    setBusy(true);
    setErr("");
    setRes(null);
    try {
      setRes(await api.post<EulaAnalysis>("/api/ai/eula", { input }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  const isUrl = /^(https?:\/\/|www\.)/i.test(input.trim());
  return (
    <div className="eula-check">
      <div className="eula-input">
        <textarea
          className="input"
          rows={input.length > 120 ? 5 : 1}
          ref={autoFocus ? focusOnMount : undefined}
          value={input}
          maxLength={50_000}
          placeholder="Ссылка, название или текст лицензии"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && input.length < 300) {
              e.preventDefault();
              void run();
            }
          }}
        />
        <button className="btn primary" disabled={busy || !input.trim()} onClick={run}>
          {busy ? "Проверяю…" : "Проверить"}
        </button>
      </div>
      {busy && (
        <div className="eula-progress">
          <span className="spinner" />
          {isUrl ? "Загружаю страницу и ищу текст лицензии…" : "Разбираю условия лицензии…"}
        </div>
      )}
      {err && <div className="err below">{err}</div>}
      {res && <EulaResult a={res} onDone={onDone} />}
    </div>
  );
}

/** Карточка вывода по лицензии + «Добавить в одобренное ПО». */
export function EulaResult({ a, onDone }: { a: EulaAnalysis; onDone?: () => void }) {
  const { isAdmin } = useAuth();
  const [name, setName] = useState(a.name ?? "");
  const [vendor, setVendor] = useState(a.vendor ?? "");
  const [kind, setKind] = useState<LicenseKind>(a.license_kind ?? "commercial");
  const [status, setStatus] = useState<"current" | "forbidden">(a.suggested_status);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ catalog_id: number; created: boolean; linked_installations: number } | null>(null);
  const [showRisks, setShowRisks] = useState(a.risks.length <= 3);
  const [label, tone, icon] = VERDICT[a.verdict];

  const approve = async () => {
    setBusy(true);
    setErr("");
    try {
      setDone(
        await api.post("/api/ai/eula/approve", {
          name: name.trim(),
          vendor: vendor.trim() || null,
          license_kind: kind,
          internal_status: status,
          license_name: a.license_name,
          commercial_use: a.commercial_use,
          copyleft: a.copyleft,
          analysis: a,
        }),
      );
      onDone?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <div className={`eula-card v-${a.verdict}`}>
      <div className="eula-head">
        <div className={`eula-verdict ${tone}`}>{icon}</div>
        <div className="grow">
          <div className="eula-title">
            {a.name ?? "Программа"}
            {a.version && <span className="faint"> {a.version}</span>}
          </div>
          <div className="muted small">{a.vendor ?? "правообладатель не указан"}</div>
        </div>
        <span className={`badge ${tone}`}>{label}</span>
      </div>
      <div className="eula-facts">
        <div>
          <span>Лицензия</span>
          <b>{a.license_name ?? "не определена"}</b>
        </div>
        <div>
          <span>Тип</span>
          <b>{a.license_kind ? KIND_LABEL[a.license_kind] : "—"}</b>
        </div>
        <div>
          <span>В организации</span>
          <b className={USE[a.commercial_use][1]}>{USE[a.commercial_use][0]}</b>
        </div>
        <div>
          <span>Copyleft</span>
          <b>{yesNo(a.copyleft)}</b>
        </div>
        <div>
          <span>Подписка</span>
          <b>{yesNo(a.subscription)}</b>
        </div>
        <div>
          <span>Право аудита</span>
          <b>{yesNo(a.audit_rights)}</b>
        </div>
        {a.seat_limit && (
          <div className="wide">
            <span>Ограничение</span>
            <b>{a.seat_limit}</b>
          </div>
        )}
      </div>
      <p className="eula-summary">{a.summary}</p>
      {a.risks.length > 0 && (
        <div className="eula-risks">
          <button className="link-btn" onClick={() => setShowRisks(!showRisks)}>
            {showRisks ? "▾" : "▸"} Риски и условия ({a.risks.length})
          </button>
          {showRisks && (
            <ul>
              {a.risks.map((r, i) => (
                <li key={i}>
                  {r.point}
                  {r.quote && <q>{r.quote}</q>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="eula-meta faint">
        {a.source === "llm" ? "Проанализировала ИИ-модель" : "Проверено по правилам"}
        {a.input_kind === "name" && " · по названию, без текста лицензии — проверьте"}
        {a.sources.map((s) => (
          <a key={s} href={s} target="_blank" rel="noopener noreferrer">
            {" "}
            · {new URL(s).hostname}
          </a>
        ))}
      </div>
      {a.existing && !done && (
        <div className="eula-existing">
          Уже в каталоге: <Link to={`/catalog/${a.existing.id}`}>{a.existing.name}</Link> — сохранение обновит позицию
        </div>
      )}

      {done ? (
        <div className="eula-done">
          ✓ {done.created ? "Добавлено в каталог" : "Позиция каталога обновлена"}
          {status === "forbidden" ? " как запрещённое" : " как одобренное"}
          {done.linked_installations > 0 && ` · привязано установок: ${done.linked_installations}`} ·{" "}
          <Link to={`/catalog/${done.catalog_id}`}>Открыть ›</Link>
        </div>
      ) : isAdmin ? (
        <div className="eula-approve">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название в каталоге"
          />
          <input className="input" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Вендор" />
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as LicenseKind)}>
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <select
            className="input"
            value={status}
            onChange={(e) => setStatus(e.target.value as "current" | "forbidden")}
          >
            <option value="current">Одобрено</option>
            <option value="forbidden">Запрещено</option>
          </select>
          <button
            className={`btn ${status === "current" ? "primary" : "danger"}`}
            disabled={busy || !name.trim()}
            onClick={approve}
          >
            {busy ? "Сохраняю…" : status === "current" ? "Добавить в одобренное ПО" : "Добавить как запрещённое"}
          </button>
          {err && <div className="err flush span-all">{err}</div>}
        </div>
      ) : null}
    </div>
  );
}
