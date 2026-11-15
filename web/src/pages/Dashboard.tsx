import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApi } from "../api/hooks.ts";
import type { Compliance, ComplianceRow, ComplianceStatus } from "../api/types.ts";
import {
  Badge,
  Dash,
  DownloadButton,
  ErrorBox,
  Kpi,
  Loading,
  TableFoot,
  usePageSize,
  rowLinkProps,
} from "../components/ui/index.ts";
import { COMPLIANCE_LABEL, kindLabel, num, rub } from "../format.ts";

const TONE = { forbidden: "red", over: "red", outdated: "amber", idle: "amber", ok: "green" } as const;
type Filter = "problems" | ComplianceStatus | "zombie" | "all";
const TITLE: Record<Filter, [string, string]> = {
  problems: ["Требуют внимания", "всё, с чем нужно что-то сделать"],
  over: ["Не хватает лицензий", "установлено больше, чем куплено — докупить или удалить лишнее"],
  forbidden: ["Запрещённое ПО", "найдено на ПК — удалить"],
  outdated: ["Устаревшее ПО", "позиция помечена устаревшей — заменить или обновить"],
  idle: ["Лицензии простаивают", "куплено больше, чем установлено — можно перенести или не продлевать"],
  zombie: ["Не используются", "стоят давно, но не запускаются (или владелец уволен) — места можно вернуть"],
  ok: ["В норме", ""],
  all: ["Все позиции каталога", ""],
};

/** Что не так со строкой — одной фразой (на вкладке «Не используются» — про неиспользуемые установки). */
function gap(r: ComplianceRow, filter: Filter) {
  if (filter === "zombie") return <span className="amber">не используют на {num(r.zombie)} ПК</span>;
  if (r.status === "forbidden")
    return (
      <span className="red">
        удалить с {num(r.installed)} ПК{r.running ? ` · запускают на ${num(r.running)}` : ""}
      </span>
    );
  if (r.deficit > 0) return <span className="red">не хватает {num(r.deficit)}</span>;
  if (r.idle > 0) return <span className="amber">свободно {num(r.idle)}</span>;
  if (r.zombie > 0) return <span className="amber">не используют на {num(r.zombie)} ПК</span>;
  return <Dash />;
}

/** Деньги по строке: штрафной риск (не хватает лицензий) или то, что можно вернуть (простой + неиспользуемые установки). */
function money(r: ComplianceRow, filter: Filter) {
  if (filter === "zombie") return <span className="amber">{rub(r.reclaimable)}</span>;
  if (r.penalty > 0)
    return (
      <span className="red" title="не хватает мест × цена места">
        {rub(r.penalty)}
      </span>
    );
  const back = r.waste + r.reclaimable;
  if (back > 0)
    return (
      <span className="amber" title="свободные места и установки, которыми не пользуются, × цена места">
        {rub(back)}
      </span>
    );
  return <Dash />;
}

/** Дашборд: плитки — это фильтры одной таблицы «куплено / установлено» (каждое число на экране встречается один раз). */
export default function Dashboard() {
  const comp = useApi<Compliance>("/api/compliance");
  const nav = useNavigate();
  const [filter, setFilterRaw] = useState<Filter>("problems");
  const [page, setPage] = useState(1);
  const [size] = usePageSize();
  const setFilter = (f: Filter) => {
    setFilterRaw(f);
    setPage(1);
  };

  const rows = useMemo(() => comp.data?.rows ?? [], [comp.data]);
  const filtered = useMemo(
    () =>
      rows.filter((r) =>
        filter === "all"
          ? true
          : filter === "problems"
            ? r.status !== "ok"
            : filter === "zombie"
              ? r.zombie > 0
              : r.status === filter,
      ),
    [rows, filter],
  );

  if (comp.loading)
    return (
      <div className="page">
        <Loading />
      </div>
    );
  if (comp.error || !comp.data)
    return (
      <div className="page">
        <ErrorBox text={comp.error ?? "нет данных"} />
      </div>
    );

  const of = (s: ComplianceStatus) => rows.filter((r) => r.status === s);
  const over = of("over"),
    forbidden = of("forbidden"),
    outdated = of("outdated");
  const missing = over.reduce((a, r) => a + r.deficit, 0);
  const forbiddenPcs = forbidden.reduce((a, r) => a + r.installed, 0);
  const idle = rows.reduce((a, r) => a + r.idle, 0);
  const problems = rows.filter((r) => r.status !== "ok").length;
  const sm = comp.data.summary;
  const forbiddenRun = forbidden.reduce((a, r) => a + r.running, 0);
  const slice = filtered.slice((page - 1) * size, page * size);
  const po = (n: number) =>
    `${n} ${n % 10 === 1 && n % 100 !== 11 ? "программа" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "программы" : "программ"}`;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Дашборд</h1>
        </div>
        <div className="actions">
          <DownloadButton href="/api/reports/management.pdf" name={`easysam-report-${today}.pdf`}>
            Отчёт PDF
          </DownloadButton>
          <DownloadButton href="/api/reports/management.xlsx" name={`easysam-report-${today}.xlsx`}>
            Отчёт Excel
          </DownloadButton>
        </div>
      </div>

      <div className="kpis">
        <Kpi
          label="Требуют внимания"
          value={problems}
          tone={problems ? undefined : "green"}
          active={filter === "problems"}
          onClick={() => setFilter("problems")}
        />
        <Kpi
          label="Не хватает лицензий"
          value={missing}
          tone={missing ? "red" : "faint"}
          hint={missing ? `мест · ${rub(sm.total_penalty)}` : undefined}
          active={filter === "over"}
          onClick={() => setFilter("over")}
        />
        <Kpi
          label="Запрещённое ПО"
          value={forbiddenPcs}
          tone={forbiddenPcs ? "red" : "faint"}
          hint={
            forbiddenPcs
              ? forbiddenRun
                ? `ПК · запускали на ${num(forbiddenRun)}`
                : "ПК · запусков не было"
              : undefined
          }
          active={filter === "forbidden"}
          onClick={() => setFilter("forbidden")}
        />
        <Kpi
          label="Устаревшее ПО"
          value={outdated.length}
          tone={outdated.length ? "amber" : "faint"}
          hint={outdated.length ? po(outdated.length).replace(/^\d+ /, "") : undefined}
          active={filter === "outdated"}
          onClick={() => setFilter("outdated")}
        />
        <Kpi
          label="Лицензий простаивает"
          value={idle}
          tone={idle ? "amber" : "faint"}
          hint={idle ? `мест · ${rub(sm.total_waste)}` : undefined}
          active={filter === "idle"}
          onClick={() => setFilter("idle")}
        />
        <Kpi
          label="Не используются"
          value={sm.zombie}
          tone={sm.zombie ? "amber" : "faint"}
          hint={sm.zombie ? `ПК · ${rub(sm.total_reclaimable)}` : undefined}
          active={filter === "zombie"}
          onClick={() => setFilter("zombie")}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <h3>{TITLE[filter][0]}</h3>
          <button
            type="button"
            className={`btn sm ${filter === "all" ? "on" : ""}`}
            aria-pressed={filter === "all"}
            onClick={() => setFilter(filter === "all" ? "problems" : "all")}
          >
            {filter === "all" ? "Только проблемы" : `Все позиции · ${rows.length}`}
          </button>
        </div>
        <table className="t">
          <thead>
            <tr>
              <th>Программа</th>
              <th>Лицензия</th>
              <th className="num">Установлено</th>
              <th className="num">Куплено</th>
              <th>Покрытие</th>
              <th>Что не так</th>
              <th className="num">Сумма</th>
              <th>Статус</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((r) => {
              const paid = r.license_kind === "commercial" || r.seats > 0;
              const pct = Math.min(100, (r.seats / Math.max(1, r.installed)) * 100);
              return (
                <tr key={r.catalog_id} {...rowLinkProps(() => nav(`/catalog/${r.catalog_id}`))}>
                  <td className="strong">{r.name}</td>
                  <td className="muted">{kindLabel(r.license_kind)}</td>
                  <td className="num">{num(r.installed)} ПК</td>
                  <td className="num">{paid ? num(r.seats) : <Dash />}</td>
                  <td>
                    {paid && r.status !== "forbidden" ? (
                      <div className="bar" title={`куплено ${r.seats} на ${r.installed} установок`}>
                        <i className={r.deficit > 0 ? "red" : "green"} style={{ width: `${pct}%` }} />
                      </div>
                    ) : (
                      <Dash />
                    )}
                  </td>
                  <td>{gap(r, filter)}</td>
                  <td className="num nowrap">{money(r, filter)}</td>
                  <td>
                    <Badge tone={TONE[r.status]}>{COMPLIANCE_LABEL[r.status]}</Badge>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length && (
          <div className="empty">{filter === "problems" ? "Проблем нет — всё в норме" : "Здесь пусто"}</div>
        )}
        <TableFoot page={page} size={size} total={filtered.length} onPage={setPage} />
      </div>
    </div>
  );
}
