import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useApi } from "../api/hooks.ts";
import { onStream } from "../api/stream.ts";
import type { EventFull } from "../api/types.ts";
import { Badge, Dash, ErrorBox, Loading, Switch, TableFoot, usePageSize } from "../components/ui/index.ts";
import { dateRu, downloadCsv, hhmm } from "../format.ts";

const TYPE_LABEL = { installed: "Установлено", updated: "Обновлено", removed: "Удалено" } as const;
const TYPE_TONE = { installed: "green", updated: "blue", removed: "amber" } as const;
const DAYS = [
  { v: 0, l: "за всё время" },
  { v: 1, l: "за сутки" },
  { v: 7, l: "за неделю" },
  { v: 30, l: "за месяц" },
];

/** Общая лента событий установки/удаления/обновления со всех ПК (GET /api/events + SSE «install»). */
export default function Events() {
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");
  const [dq, setDq] = useState(q);
  const type = sp.get("type") ?? "";
  const days = Number(sp.get("days") ?? 0);
  const problems = sp.get("problems") === "1";
  const [page, setPage] = useState(1);
  const [size] = usePageSize();
  const [live, setLive] = useState<EventFull[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setDq(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  // фильтры сменились — с первой страницы, накопленные по SSE события сбросить
  const filterKey = `${dq}|${type}|${days}|${problems}`;
  const [shownFor, setShownFor] = useState(filterKey);
  if (shownFor !== filterKey) {
    setShownFor(filterKey);
    setPage(1);
    setLive([]);
  }
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
  };

  const qs = new URLSearchParams({ limit: "2000" });
  if (type) qs.set("type", type);
  if (days) qs.set("days", String(days));
  if (dq) qs.set("q", dq);
  if (problems) qs.set("problems", "1");
  const ev = useApi<EventFull[]>(`/api/events?${qs}`, false);

  // новые события приходят по SSE; фильтры применяем и к ним
  useEffect(
    () =>
      onStream<EventFull>("install", (m) => {
        if (type && m.type !== type) return;
        if (problems && m.catalog_id && m.internal_status !== "forbidden") return;
        if (dq && !`${m.raw_name} ${m.hostname ?? ""}`.toLowerCase().includes(dq.toLowerCase())) return;
        setLive((l) => [m, ...l].slice(0, 500));
      }),
    [type, problems, dq],
  );

  const rows = useMemo(() => {
    const seen = new Set<number>();
    return [...live, ...(ev.data ?? [])].filter((e) => !seen.has(e.id) && seen.add(e.id));
  }, [live, ev.data]);
  const slice = rows.slice((page - 1) * size, page * size);

  const exportCsv = () =>
    downloadCsv("easysam-events.csv", [
      ["Время", "ПК", "Серийный номер", "Сотрудник", "Событие", "Программа", "Было", "Стало", "Каталог", "Статус"],
      ...rows.map((e) => [
        e.at,
        e.hostname ?? "",
        e.device_serial,
        e.employee ?? "",
        TYPE_LABEL[e.type],
        e.raw_name,
        e.old_version,
        e.new_version,
        e.catalog_name,
        e.internal_status,
      ]),
    ]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Лента событий</h1>
          <div className="sub">
            <span className="live">в реальном времени</span>
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={exportCsv} disabled={!rows.length}>
            Выгрузить CSV
          </button>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <input
            className="input search-wide"
            placeholder="Поиск"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              set("q", e.target.value);
            }}
          />
          <select className="input" value={type} onChange={(e) => set("type", e.target.value)}>
            <option value="">Все события</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select
            className="input"
            value={days}
            onChange={(e) => set("days", e.target.value === "0" ? "" : e.target.value)}
          >
            {DAYS.map((d) => (
              <option key={d.v} value={d.v}>
                {d.l}
              </option>
            ))}
          </select>
          <Switch checked={problems} onChange={(v) => set("problems", v ? "1" : "")}>
            Только проблемные (запрещённое и нераспознанное)
          </Switch>
        </div>
        {ev.error ? (
          <ErrorBox text={ev.error} />
        ) : ev.loading && !ev.data ? (
          <Loading />
        ) : (
          <div className="t-scroll">
            <table className="t">
              <thead>
                <tr>
                  <th>Когда</th>
                  <th>ПК</th>
                  <th>Сотрудник</th>
                  <th>Событие</th>
                  <th>Программа</th>
                  <th>Версия</th>
                  <th>В каталоге</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((e) => (
                  <tr key={e.id} className={e.internal_status === "forbidden" ? "danger" : ""}>
                    <td className="mono muted nowrap">
                      {dateRu(e.at)} {hhmm(e.at)}
                    </td>
                    <td className="mono">
                      <Link to={`/agents/${e.device_id ?? encodeURIComponent(e.device_serial)}`}>
                        {e.hostname ?? e.device_serial}
                      </Link>
                    </td>
                    <td>{e.employee ?? <Dash />}</td>
                    <td>
                      <Badge tone={TYPE_TONE[e.type]}>{TYPE_LABEL[e.type]}</Badge>
                    </td>
                    <td className="strong">{e.raw_name}</td>
                    <td className="mono muted nowrap">
                      {e.type === "updated"
                        ? `${e.old_version ?? "?"} → ${e.new_version ?? "?"}`
                        : (e.new_version ?? e.old_version ?? <Dash />)}
                    </td>
                    <td>
                      {e.catalog_id ? (
                        <Link to={`/catalog/${e.catalog_id}`}>{e.catalog_name}</Link>
                      ) : (
                        <Badge>Не распознано</Badge>
                      )}{" "}
                      {e.internal_status === "forbidden" && <Badge tone="red">Запрещено</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <div className="empty">Событий не найдено</div>}
          </div>
        )}
        <TableFoot
          page={page}
          size={size}
          total={rows.length}
          onPage={setPage}
          note={(ev.data?.length ?? 0) >= 2000 ? "показаны последние 2000 — уточните фильтр" : undefined}
        />
      </div>
    </div>
  );
}
