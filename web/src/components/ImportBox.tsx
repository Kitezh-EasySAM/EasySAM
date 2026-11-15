import { useMemo, useRef, useState } from "react";
import { api, download } from "../api/client.ts";
import type { ImportKind, ImportResult } from "../api/types.ts";
import { Modal } from "./ui/index.ts";

/** Импорт из Excel/CSV: шаблон → файл → предпросмотр (dry_run) → загрузить. inModal — без своей рамки (заголовок даёт окно). */
export function ImportBox({ kind, onDone, inModal }: { kind: ImportKind; onDone: () => void; inModal?: boolean }) {
  const [file, setFile] = useState<File | null>(null);
  const [res, setRes] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const title = useMemo(() => ({ employees: "сотрудников", catalog: "программ", purchases: "лицензий" })[kind], [kind]);

  const run = async (f: File, dry: boolean) => {
    setBusy(true);
    setErr("");
    try {
      const r = await api.upload<ImportResult>(`/api/import/${kind}${dry ? "?dry_run=1" : ""}`, f);
      setRes(r);
      if (!dry) {
        onDone();
        setFile(null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRes(null);
    }
    setBusy(false);
  };
  const pick = (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setRes(null);
    void run(f, true);
  };
  const reset = () => {
    setFile(null);
    setRes(null);
    setErr("");
    if (input.current) input.current.value = "";
  };

  return (
    <div className={inModal ? "import-modal" : "card import-card"} key={kind}>
      <div className="card-head">
        <h3>{inModal ? "" : `Импорт ${title} из Excel`}</h3>
        <button
          className="btn sm"
          onClick={() =>
            download(`/api/import/templates/${kind}.xlsx`, `easysam-${kind}.xlsx`).catch((e) => setErr(e.message))
          }
        >
          Шаблон .xlsx
        </button>
      </div>
      <div className="pad">
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
            pick(e.dataTransfer.files[0]);
          }}
        >
          <input ref={input} type="file" accept=".xlsx,.csv" hidden onChange={(e) => pick(e.target.files?.[0])} />
          <b>{file ? file.name : "Перетащите файл сюда"}</b>
          <span className="muted">
            {file ? `${Math.ceil(file.size / 1024)} КБ` : "или нажмите, чтобы выбрать .xlsx / .csv"}
          </span>
        </label>
        {busy && <div className="muted mt">Проверяю файл…</div>}
        {err && <div className="err below">{err}</div>}
        {res && !busy && (
          <div className="import-res">
            <div className="import-head">
              {res.dry_run ? "Предпросмотр — в базу ещё ничего не записано" : "Загружено"}
            </div>
            <div className="import-stats">
              <span>
                <b>{res.rows}</b> строк
              </span>
              <span className="green">
                <b>{res.created}</b> новых
              </span>
              <span>
                <b>{res.updated}</b> обновится{res.dry_run ? "" : "/обновлено"}
              </span>
              <span className={res.skipped ? "amber" : "muted"}>
                <b>{res.skipped}</b> пропущено
              </span>
            </div>
            {res.errors.length > 0 && (
              <ul className="import-errors">
                {res.errors.slice(0, 15).map((e, i) => (
                  <li key={i}>
                    <span className="mono">стр. {e.row}</span> {e.error}
                  </li>
                ))}
                {res.errors.length > 15 && <li className="muted">…и ещё {res.errors.length - 15}</li>}
              </ul>
            )}
            <div className="actions mt">
              {res.dry_run && file && (
                <button
                  className="btn primary"
                  disabled={!res.created && !res.updated}
                  onClick={() => run(file, false)}
                >
                  Загрузить {res.created + res.updated} {res.created + res.updated === 1 ? "запись" : "записей"}
                </button>
              )}
              <button className="btn" onClick={reset}>
                {res.dry_run ? "Отмена" : "Загрузить ещё файл"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Кнопка «Импорт из Excel» на странице списка: открывает окно с шаблоном, предпросмотром и загрузкой. */
export function ImportButton({ kind, onDone }: { kind: ImportKind; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn admin-only" onClick={() => setOpen(true)}>
        Импорт из Excel
      </button>
      {open && (
        <Modal
          title={kind === "catalog" ? "Импорт программ из Excel" : "Импорт закупок из Excel"}
          wide
          onClose={() => setOpen(false)}
        >
          <ImportBox kind={kind} onDone={onDone} inModal />
        </Modal>
      )}
    </>
  );
}
