import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useApi } from "../api/hooks.ts";
import type { DeviceDetail, Employee, EventRow, Software, PcLicense, ProcessRow } from "../api/types.ts";
import {
  Badge,
  ErrorBox,
  Kpi,
  Loading,
  pageSlice,
  Switch,
  TableFoot,
  Tabs,
  usePageSize,
} from "../components/ui/index.ts";
import { PRESENCE_LABEL, PRESENCE_TONE, presence, relTime } from "../format.ts";
import { EmployeePicker } from "../components/agent/EmployeePicker.tsx";
import { exportTab } from "../components/agent/exportCsv.ts";
import { EventsTable, LicensesTable, ProcessesTable, SoftwareTable } from "../components/agent/Tables.tsx";
import { APP_LABEL, LIC_ORDER, SW_ORDER, swState } from "../components/agent/labels.ts";

type Tab = "software" | "licenses" | "processes" | "events";

/** Статус строки ПО: каталог + нужная версия (старее — устарело, новее — обновилось сверх одобренной). */
export default function AgentDetail() {
  const { id = "", tab: tabParam } = useParams();
  const navTo = useNavigate();
  const { data, error, loading, reload } = useApi<DeviceDetail>(`/api/devices/${encodeURIComponent(id)}`, true, [
    "agent",
  ]);
  // старая ссылка по серийнику → короткий адрес по id
  useEffect(() => {
    if (data && String(data.device.id) !== id)
      navTo(`/agents/${data.device.id}${tabParam ? `/${tabParam}` : ""}`, { replace: true });
  }, [data, id, tabParam, navTo]);
  const tab: Tab = (["software", "licenses", "processes", "events"] as const).find((t) => t === tabParam) ?? "software";
  const setTab = (t: Tab) =>
    navTo(`/agents/${encodeURIComponent(id)}${t === "software" ? "" : `/${t}`}`, { replace: true });
  const [q, setQ] = useState("");
  const [noise, setNoise] = useState(false);
  const [page, setPage] = useState(1);
  const [PAGE] = usePageSize();
  const [type, setType] = useState("all");
  const [days, setDays] = useState(30);
  const [openedAt] = useState(Date.now); // «за N дней» — от момента открытия карточки
  const [pick, setPick] = useState(false);
  const emps = useApi<Employee[]>("/api/employees", false);

  // одна ссылка на массив, пока данные те же (иначе useMemo ниже пересчитывались бы на каждый рендер)
  const software = useMemo(() => data?.software ?? [], [data]);
  const events = useMemo(() => data?.events ?? [], [data]);
  const licenses = useMemo(() => data?.licenses ?? [], [data]);
  const processes = useMemo(() => data?.processes ?? [], [data]);
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return software
      .filter(
        (x) =>
          (noise || !x.is_noise) &&
          (!s ||
            [x.raw_name, x.raw_publisher ?? "", x.raw_version ?? "", x.catalog_name ?? ""].some((v) =>
              v.toLowerCase().includes(s),
            )),
      )
      .sort((a, b) => SW_ORDER[swState(a)] - SW_ORDER[swState(b)] || a.raw_name.localeCompare(b.raw_name, "ru"));
  }, [software, q, noise]);
  const lics = useMemo(() => {
    const s = q.trim().toLowerCase();
    return licenses
      .filter(
        (x) =>
          !s ||
          [
            x.product,
            x.description ?? "",
            x.channel ?? "",
            x.partial_key ?? "",
            APP_LABEL[x.application] ?? x.application,
          ].some((v) => v.toLowerCase().includes(s)),
      )
      .sort((a, b) => LIC_ORDER[a.severity] - LIC_ORDER[b.severity]);
  }, [licenses, q]);
  const procs = useMemo(() => {
    const s = q.trim().toLowerCase();
    return processes
      .filter(
        (x) =>
          !s ||
          [x.exe_name, x.product_name ?? "", x.company ?? "", x.catalog_name ?? "", x.installation_name ?? ""].some(
            (v) => v.toLowerCase().includes(s),
          ),
      )
      .sort((a, b) => (b.last_seen ?? "").localeCompare(a.last_seen ?? ""));
  }, [processes, q]);
  const evs = useMemo(() => {
    const s = q.trim().toLowerCase();
    const from = openedAt - days * 86400000;
    return events.filter(
      (e) =>
        (type === "all" || e.type === type) &&
        new Date(e.at.replace(" ", "T") + "Z").getTime() >= from &&
        (!s || e.raw_name.toLowerCase().includes(s) || (e.raw_publisher ?? "").toLowerCase().includes(s)),
    );
  }, [events, q, type, days, openedAt]);

  if (loading)
    return (
      <div className="page">
        <Loading />
      </div>
    );
  if (error || !data)
    return (
      <div className="page">
        <ErrorBox text={error ?? "нет данных"} back={{ to: "/agents", label: "Все рабочие места" }} />
      </div>
    );

  const d = data.device;
  const real = software.filter((x) => !x.is_noise);
  const noiseCount = software.length - real.length;
  const forbidden = real.filter((x) => swState(x) === "forbidden").length;
  const outdated = real.filter((x) => swState(x) === "outdated").length;
  const versionMismatch = real.filter((x) => x.version_match && x.version_match !== "ok").length;
  const unknown = real.filter((x) => swState(x) === "unknown").length;
  const licRisks = licenses.filter((x) => x.risks.length > 0).length;
  const owner = emps.data?.find((e) => e.id === d.employee_id);
  const p = presence(d);
  const rows = tab === "software" ? visible : tab === "licenses" ? lics : tab === "processes" ? procs : evs;
  const { slice } = pageSlice(rows as unknown[], page, PAGE);
  const switchTab = (t: Tab) => {
    setTab(t);
    setQ("");
    setPage(1);
  };

  const exportCsv = () =>
    exportTab(
      d.hostname,
      tab === "software"
        ? { tab, rows: visible }
        : tab === "licenses"
          ? { tab, rows: lics }
          : tab === "processes"
            ? { tab, rows: procs }
            : { tab, rows: evs },
    );

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/agents">Рабочие места</Link> &nbsp;/&nbsp; <b>{d.hostname}</b>
      </div>
      <div className="page-head">
        <div className="title-row">
          <div className="avatar">PC</div>
          <div>
            <div className="title-row">
              <h1>{d.hostname}</h1>
              <Badge tone={PRESENCE_TONE[p]} dot>
                {PRESENCE_LABEL[p]}
              </Badge>
            </div>
            <div className="sub muted">
              {[owner?.full_name, owner?.department, d.os, `S/N ${d.serial_number}`].filter(Boolean).join(" · ")}
            </div>
          </div>
        </div>
        <div className="actions">
          <button className="btn admin-only" onClick={() => setPick(true)}>
            Сменить сотрудника
          </button>
        </div>
      </div>

      <div className="kpis">
        <Kpi label="Связь с агентом" value={d.agent_last_seen ? relTime(d.agent_last_seen) : "агента нет"} small />
        <Kpi label="Запрещённых" value={forbidden} tone={forbidden ? "red" : undefined} small />
        <Kpi label="Устаревших" value={outdated} tone={outdated ? "amber" : undefined} small />
        <Kpi label="Не с той версией" value={versionMismatch} tone={versionMismatch ? "amber" : undefined} small />
        <Kpi label="Нераспределённых" value={unknown} small />
        <Kpi label="Лицензии с рисками" value={licRisks} tone={licRisks ? "red" : undefined} small />
      </div>

      <div className="card">
        <Tabs<Tab>
          value={tab}
          onChange={switchTab}
          items={[
            { id: "software", label: "Установленное ПО", n: real.length },
            { id: "licenses", label: "Лицензии ПК", n: licenses.length },
            { id: "processes", label: "Запущенные программы", n: processes.length },
            { id: "events", label: "События", n: events.length },
          ]}
        />
        <div className="toolbar">
          <input
            className="input"
            placeholder="Поиск"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
          />
          {tab === "software" ? (
            <Switch
              checked={noise}
              onChange={(v) => {
                setNoise(v);
                setPage(1);
              }}
            >
              Показать шум ({noiseCount})
            </Switch>
          ) : tab === "events" ? (
            <>
              <select
                className="input"
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  setPage(1);
                }}
              >
                <option value="all">Тип: все</option>
                <option value="installed">Установлено</option>
                <option value="updated">Обновлено</option>
                <option value="removed">Удалено</option>
              </select>
              <select
                className="input"
                value={days}
                onChange={(e) => {
                  setDays(+e.target.value);
                  setPage(1);
                }}
              >
                <option value={7}>Период: 7 дней</option>
                <option value={30}>Период: 30 дней</option>
                <option value={365}>Период: год</option>
              </select>
            </>
          ) : null}
          <span className="end">
            <button className="btn" onClick={exportCsv}>
              Экспорт .csv
            </button>
          </span>
        </div>

        {tab === "software" ? (
          <SoftwareTable rows={slice as Software[]} />
        ) : tab === "licenses" ? (
          <LicensesTable rows={slice as PcLicense[]} />
        ) : tab === "processes" ? (
          <ProcessesTable rows={slice as ProcessRow[]} />
        ) : (
          <EventsTable rows={slice as EventRow[]} />
        )}
        {rows.length === 0 && <div className="empty">Ничего не найдено</div>}
        <TableFoot page={page} size={PAGE} total={rows.length} onPage={setPage} />
      </div>

      {pick && (
        <EmployeePicker
          serial={String(d.id ?? d.serial_number)}
          current={d.employee_id}
          onClose={() => setPick(false)}
          onDone={() => {
            setPick(false);
            reload();
          }}
        />
      )}
    </div>
  );
}
