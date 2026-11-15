import { useRef, useState } from "react";
import { api } from "../api/client.ts";
import { useApi } from "../api/hooks.ts";
import type { Device } from "../api/types.ts";
import { dateRu, num } from "../format.ts";

interface IngestResult {
  batch_id: number;
  rows_in_file: number;
  rows_total: number;
  rows_noise: number;
  rows_matched: number;
  rows_unknown: number;
  devices: number;
  events: number;
}
interface Batch {
  id: number;
  source: string;
  created_at: string;
  rows_total: number;
  rows_noise: number;
  rows_matched: number;
  rows_unknown: number;
}
interface ManualResult {
  serial_number: string;
  catalog_id: number | null;
  catalog_name: string | null;
  is_noise: boolean;
}
const SOURCE: Record<string, string> = { csv: "Файл", agent: "Агент", manual: "Вручную" };

/**
 * «Настройки» → «Установки на ПК»: выгрузка установленного ПО файлом (POST /api/ingest/csv — тот же конвейер,
 * что у агента) и одна установка вручную (POST /api/ingest/manual). API §6.
 */
export function InstallsEntry({ isAdmin }: { isAdmin: boolean }) {
  const batches = useApi<Batch[]>("/api/ingest/batches");
  const devices = useApi<Device[]>(isAdmin ? "/api/devices" : null, false);
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<IngestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const [m, setM] = useState({ serial_number: "", hostname: "", name: "", publisher: "", version: "" });
  const [mRes, setMRes] = useState<ManualResult | null>(null);
  const [mErr, setMErr] = useState("");
  const [mBusy, setMBusy] = useState(false);
  const known = devices.data?.find((d) => d.serial_number === m.serial_number.trim());

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setRes(null);
    setErr("");
    setBusy(true);
    try {
      setRes(await api.upload<IngestResult>("/api/ingest/csv", f));
      batches.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
    if (input.current) input.current.value = "";
  };

  const addManual = async (e: React.FormEvent) => {
    e.preventDefault();
    setMBusy(true);
    setMErr("");
    setMRes(null);
    try {
      setMRes(
        await api.post<ManualResult>("/api/ingest/manual", {
          serial_number: m.serial_number.trim(),
          hostname: m.hostname.trim() || null,
          name: m.name.trim(),
          publisher: m.publisher.trim() || null,
          version: m.version.trim() || null,
        }),
      );
      setM({ ...m, name: "", publisher: "", version: "" });
      devices.reload();
    } catch (x) {
      setMErr(x instanceof Error ? x.message : String(x));
    }
    setMBusy(false);
  };

  return (
    <>
      {isAdmin && (
        <div className="installs-grid">
          <div className="installs-box">
            <h3>Файл выгрузки</h3>
            <p className="muted">
              .csv или .xlsx с колонками SERIAL_NUMBER, DISPLAYNAME, PUBLISHER, VERSION. Файл — полный список ПО тех ПК,
              что в нём есть.
            </p>
            <label
              className={`drop ${drag ? "over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDrag(true);
              }}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDrag(false);
                void upload(e.dataTransfer.files[0]);
              }}
            >
              <input ref={input} type="file" accept=".xlsx,.csv" hidden onChange={(e) => upload(e.target.files?.[0])} />
              <b>{busy ? "Загружаю…" : file && !err ? file.name : "Перетащите файл сюда"}</b>
              <span className="muted">или нажмите, чтобы выбрать .csv / .xlsx</span>
            </label>
            {err && <div className="err below">{err}</div>}
            {res && (
              <div className="import-res">
                <div className="import-head">
                  Загружено: {num(res.devices)} ПК, {num(res.rows_in_file)} строк
                </div>
                <div className="import-stats">
                  <span className="green">
                    <b>{num(res.rows_matched)}</b> распознано
                  </span>
                  <span className={res.rows_unknown ? "amber" : "muted"}>
                    <b>{num(res.rows_unknown)}</b> нераспределено
                  </span>
                  <span className="muted">
                    <b>{num(res.rows_noise)}</b> служебных компонентов
                  </span>
                  <span>
                    <b>{num(res.events)}</b> изменений
                  </span>
                </div>
              </div>
            )}
          </div>

          <form className="installs-box" onSubmit={addManual}>
            <h3>Одна установка вручную</h3>
            <div className="form">
              <label className="field half">
                <span>
                  Серийный номер ПК <b className="req">*</b>
                </span>
                <input
                  className="input mono"
                  list="known-devices"
                  value={m.serial_number}
                  maxLength={200}
                  required
                  onChange={(e) => setM({ ...m, serial_number: e.target.value })}
                />
                <datalist id="known-devices">
                  {(devices.data ?? []).slice(0, 500).map((d) => (
                    <option key={d.serial_number} value={d.serial_number}>
                      {d.hostname}
                    </option>
                  ))}
                </datalist>
              </label>
              <label className="field half">
                <span>Имя ПК</span>
                <input
                  className="input"
                  value={known ? known.hostname : m.hostname}
                  disabled={!!known}
                  maxLength={200}
                  onChange={(e) => setM({ ...m, hostname: e.target.value })}
                />
              </label>
              <label className="field">
                <span>
                  Программа <b className="req">*</b>
                </span>
                <input
                  className="input"
                  value={m.name}
                  maxLength={500}
                  required
                  onChange={(e) => setM({ ...m, name: e.target.value })}
                />
              </label>
              <label className="field half">
                <span>Издатель</span>
                <input
                  className="input"
                  value={m.publisher}
                  maxLength={300}
                  onChange={(e) => setM({ ...m, publisher: e.target.value })}
                />
              </label>
              <label className="field half">
                <span>Версия</span>
                <input
                  className="input"
                  value={m.version}
                  maxLength={100}
                  onChange={(e) => setM({ ...m, version: e.target.value })}
                />
              </label>
            </div>
            {mErr && (
              <div className="uf-err" role="alert">
                {mErr}
              </div>
            )}
            {mRes && (
              <div className="ca-done">
                <b>Установка записана</b>
                <span className="muted">
                  {mRes.is_noise
                    ? "служебный компонент — в учёте не участвует"
                    : mRes.catalog_name
                      ? `распознано как «${mRes.catalog_name}»`
                      : "в каталоге не найдено — смотрите «Каталог ПО» → «Нераспределённое»"}
                </span>
              </div>
            )}
            <div>
              <button
                type="submit"
                className="btn primary"
                disabled={mBusy || !m.serial_number.trim() || !m.name.trim()}
              >
                {mBusy ? "Сохраняю…" : "Добавить установку"}
              </button>
            </div>
          </form>
        </div>
      )}

      <table className="t">
        <thead>
          <tr>
            <th>Загрузка</th>
            <th>Источник</th>
            <th>Когда</th>
            <th className="num">Строк</th>
            <th className="num">Распознано</th>
            <th className="num">Нераспределено</th>
            <th className="num">Служебных</th>
          </tr>
        </thead>
        <tbody>
          {(batches.data ?? []).slice(0, 20).map((b) => (
            <tr key={b.id}>
              <td className="mono muted">№ {b.id}</td>
              <td>{SOURCE[b.source] ?? b.source}</td>
              <td className="muted">{dateRu(b.created_at)}</td>
              <td className="num">{num(b.rows_total)}</td>
              <td className="num">{num(b.rows_matched)}</td>
              <td className="num">{num(b.rows_unknown)}</td>
              <td className="num">{num(b.rows_noise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!batches.data?.length && <div className="empty">{batches.loading ? "…" : "Загрузок ещё не было"}</div>}
    </>
  );
}
