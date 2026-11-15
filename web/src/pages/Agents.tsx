import { useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useApi } from "../api/hooks.ts";
import type { Device } from "../api/types.ts";
import { AgentSetup } from "../components/ConnectAgent.tsx";
import { useAuth } from "../api/auth.tsx";
import {
  Badge,
  DownloadButton,
  Dash,
  ErrorBox,
  Kpi,
  Loading,
  pageSlice,
  TableFoot,
  Tabs,
  usePageSize,
  rowLinkProps,
} from "../components/ui/index.ts";
import { PRESENCE_LABEL, PRESENCE_TONE, num, presence, relTime, type Presence } from "../format.ts";

type Filter = "all" | Presence | "violations";

export default function Agents() {
  const { data, error, loading } = useApi<Device[]>("/api/devices", true, ["agent"]);
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const { isAdmin } = useAuth();
  const setup = useLocation().pathname.endsWith("/setup") && isAdmin; // вкладка «Установка агента» — только admin
  const [tab, setTab] = useState<Filter>("all");
  const [page, setPage] = useState(1);
  const [PAGE] = usePageSize();

  const all = useMemo(() => data ?? [], [data]);
  const counts = useMemo(() => {
    const c = { all: all.length, online: 0, offline: 0, lost: 0, no_agent: 0, violations: 0 };
    for (const d of all) {
      c[presence(d)]++;
      if (d.forbidden_count > 0) c.violations++;
    }
    return c;
  }, [all]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter((d) => {
      if (tab === "violations" ? d.forbidden_count === 0 : tab !== "all" && presence(d) !== tab) return false;
      return (
        !s ||
        [d.hostname, d.serial_number, d.employee ?? "", d.department ?? ""].some((v) => v.toLowerCase().includes(s))
      );
    });
  }, [all, q, tab]);

  const { slice } = pageSlice(rows, page, PAGE);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Рабочие места</h1>
          <div className="sub">
            {num(all.length)} ПК · {num(all.reduce((a, d) => a + d.software_count, 0))} установок ПО
          </div>
        </div>
        {!setup && (
          <div className="actions">
            <input
              className="input"
              placeholder="Поиск"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
            <DownloadButton
              href="/api/export/agents.xlsx"
              name={`easysam-agents-${new Date().toISOString().slice(0, 10)}.xlsx`}
            >
              Выгрузить в Excel
            </DownloadButton>
          </div>
        )}
      </div>

      {isAdmin && (
        <div className="page-tabs">
          <Tabs
            items={[
              { id: "list", label: "Список ПК", n: all.length },
              { id: "setup", label: "Установка агента" },
            ]}
            value={setup ? "setup" : "list"}
            onChange={(t) => nav(t === "setup" ? "/agents/setup" : "/agents")}
          />
        </div>
      )}
      {setup ? (
        <AgentSetup />
      ) : (
        <>
          <div className="kpis">
            {(
              [
                ["all", "Все ПК", counts.all, undefined, "весь список"],
                ["online", "В сети", counts.online, "green", "агент на связи"],
                ["offline", "Не в сети", counts.offline, "faint", "молчит до 7 дней"],
                ["lost", "Нет связи", counts.lost, counts.lost ? "amber" : "faint", "больше 7 дней"],
                ["no_agent", "Без агента", counts.no_agent, "faint", "данные из файла"],
                [
                  "violations",
                  "С запрещённым ПО",
                  counts.violations,
                  counts.violations ? "red" : "faint",
                  "нужно удалить",
                ],
              ] as [Filter, string, number, "green" | "faint" | "amber" | "red" | undefined, string][]
            ).map(([id, label, n, tone]) => (
              <Kpi
                key={id}
                label={label}
                value={n}
                tone={tone}
                active={tab === id}
                onClick={() => {
                  setTab(id);
                  setPage(1);
                }}
              />
            ))}
          </div>

          <div className="card">
            {loading ? (
              <Loading />
            ) : error ? (
              <ErrorBox text={error} />
            ) : (
              <table className="t">
                <thead>
                  <tr>
                    <th>Статус</th>
                    <th>Хост</th>
                    <th>S/N</th>
                    <th>Сотрудник</th>
                    <th>Отдел</th>
                    <th>ОС</th>
                    <th className="num">Программ</th>
                    <th>Запрещённое</th>
                    <th className="num">Нераспределённое</th>
                    <th className="right">Связь с агентом</th>
                  </tr>
                </thead>
                <tbody>
                  {slice.map((d) => {
                    const p = presence(d);
                    return (
                      <tr key={d.serial_number} {...rowLinkProps(() => nav(`/agents/${d.id}`))}>
                        <td>
                          <Badge tone={PRESENCE_TONE[p]} dot>
                            {PRESENCE_LABEL[p]}
                          </Badge>
                        </td>
                        <td className="hostlink">{d.hostname}</td>
                        <td className="mono muted">{d.serial_number}</td>
                        <td>{d.employee ?? <Dash />}</td>
                        <td className="muted">{d.department ?? (d.employee ? <Dash /> : "Не назначен")}</td>
                        <td className="muted">{d.os ?? <Dash />}</td>
                        <td className="num">{d.software_count}</td>
                        <td>{d.forbidden_count ? <Badge tone="red">{d.forbidden_count} запрещ.</Badge> : <Dash />}</td>
                        <td className={`num ${d.unknown_count >= 9 ? "amber" : ""}`}>{d.unknown_count || <Dash />}</td>
                        <td
                          className="right muted nowrap"
                          title={d.agent_last_seen ? undefined : `данные из загрузки файла, ${relTime(d.last_seen)}`}
                        >
                          {d.agent_last_seen ? relTime(d.agent_last_seen) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <TableFoot page={page} size={PAGE} total={rows.length} onPage={setPage} />
          </div>
        </>
      )}
    </div>
  );
}
