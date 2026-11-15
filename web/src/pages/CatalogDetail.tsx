import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.ts";
import { useApi } from "../api/hooks.ts";
import type { CatalogDevice, CatalogItem, InternalStatus, Purchase } from "../api/types.ts";
import {
  Badge,
  ConfirmModal,
  Dash,
  ErrorBox,
  Kpi,
  Loading,
  TableFoot,
  usePageSize,
  rowLinkProps,
} from "../components/ui/index.ts";
import { byCodeUnit, dateRu, kindLabel, relTime } from "../format.ts";

type Detail = CatalogItem & { devices: CatalogDevice[]; purchases: Purchase[] };
const LABEL = { current: "Актуальный", outdated: "Устаревший", forbidden: "Запрещён" } as const;
const TONE = { current: "green", outdated: "amber", forbidden: "red" } as const;
const HEAD = { current: "", outdated: "", forbidden: "Запрещён к установке" } as const;
const VERSION_TITLE = { older: "версия ниже нужной", newer: "приложение обновилось сверх нужной" } as const;

export default function CatalogDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<Detail>(`/api/catalog/${id}`);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [removing, setRemoving] = useState(false);
  const [minVer, setMinVer] = useState<string | null>(null);

  // поле «Нужная версия» следует за данными сервера (в т.ч. после reload): новые данные — новое значение поля
  const [minVerOf, setMinVerOf] = useState(data);
  if (data && data !== minVerOf) {
    setMinVerOf(data);
    setMinVer(data.min_version ?? "");
  }

  // одна строка на ПК: у ПК бывает несколько записей одной программы (компоненты, две версии) — показываем худшую версию и число записей
  const perPc = useMemo(() => {
    const rank = { older: 2, newer: 1, ok: 0 } as const;
    const m = new Map<string, CatalogDevice & { copies: number }>();
    for (const d of data?.devices ?? []) {
      const cur = m.get(d.device_serial);
      if (!cur) {
        m.set(d.device_serial, { ...d, copies: 1 });
        continue;
      }
      const worse = (d.version_match ? rank[d.version_match] : -1) > (cur.version_match ? rank[cur.version_match] : -1);
      const last =
        [cur.last_used, d.last_used]
          .filter((s): s is string => !!s)
          .sort(byCodeUnit)
          .pop() ?? null;
      m.set(d.device_serial, { ...(worse ? d : cur), copies: cur.copies + 1, last_used: last });
    }
    return [...m.values()];
  }, [data]);
  const devices = useMemo(() => {
    const s = q.trim().toLowerCase();
    return perPc.filter(
      (d) => !s || [d.hostname, d.device_serial, d.employee ?? ""].some((v) => v.toLowerCase().includes(s)),
    );
  }, [perPc, q]);
  const [page, setPage] = useState(1);
  const [size] = usePageSize();

  if (loading)
    return (
      <div className="page">
        <Loading />
      </div>
    );
  if (error || !data)
    return (
      <div className="page">
        <ErrorBox text={error ?? "нет данных"} back={{ to: "/catalog", label: "Каталог ПО" }} />
      </div>
    );

  const setStatus = (s: InternalStatus) =>
    s !== data.internal_status &&
    api.patch(`/api/catalog/${id}`, { internal_status: s }).then(reload, (e) => setErr(e.message));
  const saveMinVer = () =>
    (minVer ?? "").trim() !== (data.min_version ?? "") &&
    api
      .patch(`/api/catalog/${id}`, { min_version: (minVer ?? "").trim() || null })
      .then(reload, (e) => setErr(e.message));
  const versions = new Set(data.devices.map((d) => d.raw_version).filter(Boolean)).size;
  const depts = new Set(data.devices.map((d) => d.department).filter(Boolean)).size;
  const mismatch = perPc.filter((d) => d.version_match && d.version_match !== "ok").length;
  const bought = data.purchases.filter((p) => p.active).reduce((a, p) => a + p.seats, 0);
  const paid = data.license_kind === "commercial" || bought > 0;
  const slice = devices.slice((page - 1) * size, page * size);
  const sub = [
    data.vendor,
    data.purpose,
    kindLabel(data.license_kind),
    data.in_ru_registry ? "в российском реестре" : "нет в российском реестре",
  ]
    .filter(Boolean)
    .join(" · ");
  const initials = data.name
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/catalog">Каталог ПО</Link> &nbsp;/&nbsp; <b>{data.name}</b>
      </div>
      <div className="page-head">
        <div className="title-row">
          <div className="avatar">{initials}</div>
          <div>
            <div className="title-row">
              <h1>{data.name}</h1>
              {HEAD[data.internal_status] && (
                <Badge tone={TONE[data.internal_status]}>{HEAD[data.internal_status]}</Badge>
              )}
            </div>
            <div className="sub muted">{sub}</div>
          </div>
        </div>
        <div className="actions">
          <button className="btn" onClick={() => nav("/catalog")}>
            ← К каталогу
          </button>
          <button className="btn danger admin-only" onClick={() => setRemoving(true)}>
            Удалить из каталога
          </button>
        </div>
      </div>

      <div className="kpis">
        <Kpi
          label="Установлено на ПК"
          value={data.installed}
          tone={data.internal_status === "forbidden" && data.installed ? "red" : undefined}
          small
        />
        {paid && (
          <Kpi
            label="Куплено мест"
            value={bought}
            small
            tone={data.installed > bought ? "red" : undefined}
            hint={
              data.installed > bought
                ? `не хватает ${data.installed - bought}`
                : bought > data.installed
                  ? `свободно ${bought - data.installed}`
                  : undefined
            }
          />
        )}
        <Kpi
          label="ПК не с той версией"
          value={mismatch}
          tone={mismatch ? "amber" : undefined}
          small
          hint={data.min_version ? `нужная ${data.min_version}` : undefined}
        />
        <Kpi label="Разных версий" value={versions} small hint={`в ${depts} отделах`} />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card-head">
            <h3>На каких ПК стоит</h3>
            <input
              className="input"
              placeholder="Поиск"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <table className="t">
            <thead>
              <tr>
                <th>Хост</th>
                <th>S/N</th>
                <th>Сотрудник</th>
                <th>Отдел</th>
                <th>Версия</th>
                <th>Последний запуск</th>
              </tr>
            </thead>
            <tbody>
              {slice.map((d) => (
                <tr key={d.device_serial} {...rowLinkProps(() => nav(`/agents/${d.device_id}`))}>
                  <td className="hostlink">{d.hostname}</td>
                  <td className="mono muted">{d.device_serial}</td>
                  <td>
                    {d.employee ?? <Dash />}
                    {d.employee && !d.employee_active && (
                      <>
                        {" "}
                        <Badge tone="amber">уволен</Badge>
                      </>
                    )}
                  </td>
                  <td className="muted">{d.department ?? <Dash />}</td>
                  <td
                    className={`mono ${d.version_match && d.version_match !== "ok" ? "amber" : ""}`}
                    title={
                      d.version_match && d.version_match !== "ok"
                        ? `${VERSION_TITLE[d.version_match]} (нужная ${data.min_version})`
                        : undefined
                    }
                  >
                    {d.raw_version ?? <Dash />}
                  </td>
                  <td className="muted">{d.last_used ? relTime(d.last_used) : <Dash />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {devices.length === 0 && <div className="empty">Нет установок</div>}
          <TableFoot page={page} size={size} total={devices.length} onPage={setPage} />
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h3>Статус в организации</h3>
            </div>
            <div className="seg admin-edit">
              {(["current", "outdated", "forbidden"] as const).map((s) => (
                <span
                  key={s}
                  role="button"
                  tabIndex={0}
                  aria-pressed={data.internal_status === s}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void setStatus(s);
                    }
                  }}
                  className={`clickable ${data.internal_status === s ? "on" : ""} ${s === "forbidden" ? "red" : s === "outdated" ? "amber" : "green"}`}
                  onClick={() => setStatus(s)}
                >
                  {LABEL[s]}
                </span>
              ))}
            </div>
            <div className="kv mt">
              <dt className="muted">Нужная версия</dt>
              <dd>
                <input
                  className="input mono admin-edit ver-input"
                  value={minVer ?? ""}
                  onChange={(e) => setMinVer(e.target.value)}
                  onBlur={saveMinVer}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              </dd>
            </div>
            {err && <div className="err flush-top">{err}</div>}
          </div>
          <div className="card">
            <div className="card-head">
              <h3>О программе</h3>
            </div>
            <dl className="flush">
              {(
                [
                  ["Вендор", data.vendor],
                  ["Назначение", data.purpose],
                  ["Раздел реестра", data.registry_section],
                  ["Класс", data.registry_class],
                  ["Российский реестр", data.in_ru_registry ? "Да" : "Нет"],
                  ["Тип лицензии", kindLabel(data.license_kind)],
                  ["Соглашение", data.license_type_name],
                ] as [string, string | null][]
              ).map(([k, v]) => (
                <div className="kv" key={k}>
                  <dt>{k}</dt>
                  <dd>{v ?? <Dash />}</dd>
                </div>
              ))}
            </dl>
          </div>
          {data.purchases.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h3>Закупки</h3>
              </div>
              {data.purchases.map((p) => (
                <div className="kv two" key={p.id}>
                  <dt className={p.active ? "" : "faint"}>
                    {p.contract ?? `Закупка ${p.id}`} · {p.seats} мест
                  </dt>
                  <dd className="muted">{p.valid_until ? dateRu(p.valid_until) : "бессрочно"}</dd>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {removing && (
        <ConfirmModal
          title={`Удалить «${data.name}» из каталога?`}
          confirmLabel="Удалить"
          danger
          onConfirm={async () => {
            await api.del(`/api/catalog/${data.id}`);
            nav("/catalog");
          }}
          onClose={() => setRemoving(false)}
        />
      )}
    </div>
  );
}
