import type { EventRow, PcLicense, ProcessRow, Software } from "../../api/types.ts";
import { dateRu, kindLabel, relTime } from "../../format.ts";
import { Badge, Dash } from "../ui/index.ts";
import {
  APP_LABEL,
  EVENT_LABEL,
  EVENT_TONE,
  LIC_STATUS_LABEL,
  LIC_STATUS_TONE,
  METHOD_LABEL,
  RISK_LABEL,
  SW_CLASS,
  SW_LABEL,
  SW_METHOD,
  swState,
  VERSION_TITLE,
} from "./labels.ts";

// Таблицы вкладок карточки ПК: установленное ПО, лицензии с ПК, запущенные программы, события. rows — текущая страница.

export function SoftwareTable({ rows }: { rows: Software[] }) {
  return (
    <table className="t">
      <thead>
        <tr>
          <th className="icon-col" />
          <th>Программа</th>
          <th>Издатель</th>
          <th>Версия</th>
          <th>Лицензия</th>
          <th>Как распознано</th>
          <th>Последний запуск</th>
          <th>Статус</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((x) => {
          const st = swState(x);
          const vm = x.version_match && x.version_match !== "ok" ? x.version_match : null;
          return (
            <tr key={x.id}>
              <td>
                <span className={`dotc ${SW_CLASS[st] === "muted" ? "" : SW_CLASS[st]}`} />
              </td>
              <td>
                <div>{x.raw_name}</div>
                <div className="sub-line">→ {x.catalog_name ?? "не распознано"}</div>
              </td>
              <td>{x.raw_publisher ?? <Dash />}</td>
              <td
                className={`mono ${vm ? "amber" : ""}`}
                title={vm ? `${VERSION_TITLE[vm]} (нужная ${x.min_version})` : undefined}
              >
                {x.raw_version ?? <Dash />}
              </td>
              <td className="muted">{x.license_kind ? kindLabel(x.license_kind) : <Dash />}</td>
              <td className="muted">{x.match_method ? (SW_METHOD[x.match_method] ?? x.match_method) : <Dash />}</td>
              <td className="muted nowrap" title={x.last_used ?? "агент ещё не видел запуска"}>
                {x.last_used ? relTime(x.last_used) : <Dash />}
              </td>
              <td className={SW_CLASS[st]}>{SW_LABEL[st]}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function LicensesTable({ rows }: { rows: PcLicense[] }) {
  return (
    <table className="t">
      <thead>
        <tr>
          <th>Приложение</th>
          <th>Продукт</th>
          <th>Канал</th>
          <th>Ключ</th>
          <th>Статус</th>
          <th>Действует до</th>
          <th>Риски</th>
          <th>Собрано</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((x) => (
          <tr key={x.id}>
            <td>{APP_LABEL[x.application] ?? x.application}</td>
            <td>
              <div>{x.product}</div>
              {x.description && <div className="sub-line">{x.description}</div>}
            </td>
            <td className="mono muted">{x.channel ?? <Dash />}</td>
            <td className="mono">{x.partial_key ?? <Dash />}</td>
            <td>
              <Badge tone={LIC_STATUS_TONE[x.status]}>{LIC_STATUS_LABEL[x.status] ?? x.status}</Badge>
            </td>
            <td className="muted nowrap">{dateRu(x.expires_at)}</td>
            <td>
              {x.risks.length ? (
                x.risks.map((r) => (
                  <Badge key={r} tone={x.severity === "red" ? "red" : "amber"}>
                    {RISK_LABEL[r] ?? r}
                  </Badge>
                ))
              ) : (
                <span className="muted">нет</span>
              )}
            </td>
            <td className="muted nowrap" title={x.collected_at ?? undefined}>
              {x.collected_at ? relTime(x.collected_at) : <Dash />}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ProcessesTable({ rows }: { rows: ProcessRow[] }) {
  return (
    <table className="t">
      <thead>
        <tr>
          <th className="icon-col" />
          <th>Программа</th>
          <th>Издатель</th>
          <th>Версия</th>
          <th>Как распознано</th>
          <th>Последний запуск</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((x) => {
          const linked = x.catalog_name ?? x.installation_name;
          return (
            <tr key={x.id}>
              <td>
                {x.portable && (
                  <Badge tone="amber" dot>
                    Переносное
                  </Badge>
                )}
                {x.match_method === "installer" && <Badge tone="blue">Установщик</Badge>}
              </td>
              <td>
                <div>{x.product_name ?? x.exe_name}</div>
                <div className="sub-line mono">{x.exe_path}</div>
              </td>
              <td>{x.company ?? <Dash />}</td>
              <td className="mono">{x.file_version ?? <Dash />}</td>
              <td>
                <div>{linked ?? "не сопоставлено"}</div>
                <div className="sub-line">
                  {x.match_method ? (METHOD_LABEL[x.match_method] ?? x.match_method) : "—"}
                  {x.catalog_name && x.internal_status ? (
                    <span>
                      {" "}
                      · <b className={SW_CLASS[swState(x)]}>{SW_LABEL[swState(x)]}</b>
                    </span>
                  ) : null}
                </div>
              </td>
              <td className="muted nowrap" title={x.last_seen ?? undefined}>
                {x.last_seen ? `${relTime(x.last_seen)} · ${x.samples} замеров` : <Dash />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function EventsTable({ rows }: { rows: EventRow[] }) {
  return (
    <table className="t">
      <thead>
        <tr>
          <th>Время</th>
          <th>Тип</th>
          <th>Программа</th>
          <th>Издатель</th>
          <th>Версия: было → стало</th>
          <th>Статус</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => {
          const st = swState(e);
          return (
            <tr key={e.id}>
              <td className="muted nowrap" title={`${e.at} UTC`}>
                {relTime(e.at)}
              </td>
              <td>
                <Badge tone={EVENT_TONE[e.type]}>{EVENT_LABEL[e.type]}</Badge>
              </td>
              <td>
                <div>{e.raw_name}</div>
                <div className="sub-line">→ {e.catalog_name ?? "не распознано"}</div>
              </td>
              <td>{e.raw_publisher ?? <Dash />}</td>
              <td className="mono">
                {e.old_version ?? "—"} → {e.new_version ?? "—"}
              </td>
              <td className={SW_CLASS[st]}>{SW_LABEL[st]}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
