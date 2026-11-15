import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { aiAddHref } from "../../format.ts";
import { Modal } from "./Modal.tsx";
import { AutoInput, SearchSelect, type Option } from "./SearchSelect.tsx";

export interface FieldDef {
  key: string;
  label: string;
  type?: "text" | "number" | "date" | "select" | "textarea" | "search"; // search — длинный список с поиском (SearchSelect)
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  value?: string;
  half?: boolean; // в узкую колонку сетки
  suggestions?: Option[]; // автокомплит для текстовых полей (AutoInput)
  /** выбрана подсказка → значения других полей (заполняются, только если они пустые) */
  autofill?: (o: Option) => Record<string, string>;
  /** кнопка «Заполнить с ИИ»: значение поля (название или ссылка) уходит в чат запросом на добавление программы */
  ai?: boolean;
  /** подсказка/заглушка, зависящие от других полей формы (например, от выбранного продукта) */
  hintFor?: (values: Record<string, string>) => string | undefined;
  placeholderFor?: (values: Record<string, string>) => string | undefined;
}

/** Модальная форма «Добавить…»: сам держит значения полей, onSubmit возвращает Promise — ошибка показывается внутри. */
export function FormModal({
  title,
  fields,
  onClose,
  onSubmit,
  submitLabel = "Добавить",
}: {
  title: string;
  fields: FieldDef[];
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void>;
  submitLabel?: string;
}) {
  const [v, setV] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields.map((f) => {
        if (f.value !== undefined) return [f.key, f.value];
        // селект без явного дефолта: если есть пустой вариант-заглушка — оставляем его, иначе первый вариант
        if (f.type === "select")
          return [f.key, f.options?.some((o) => o.value === "") ? "" : (f.options?.[0]?.value ?? "")];
        return [f.key, ""];
      }),
    ),
  );
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const set = (k: string, val: string) => setV((old) => ({ ...old, [k]: val }));
  const submit = async () => {
    setBusy(true);
    setErr("");
    try {
      await onSubmit(v);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} wide={fields.length > 6}>
      <div className="form">
        {fields.map((f) => (
          <label key={f.key} className={`field ${f.half || f.type === "select" || f.type === "date" ? "half" : ""}`}>
            <span>
              {f.label}
              {f.required && <b className="req"> *</b>}
            </span>
            <span className={`field-in ${f.ai ? "field-ai" : ""}`}>
              {f.type === "search" ? (
                <SearchSelect
                  options={f.options ?? []}
                  value={v[f.key]}
                  onChange={(val) => set(f.key, val)}
                  placeholder=""
                />
              ) : f.type === "select" ? (
                <select className="input" value={v[f.key]} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options?.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.suggestions && (!f.type || f.type === "text") ? (
                <AutoInput
                  value={v[f.key]}
                  options={f.suggestions}
                  onChange={(val) => set(f.key, val)}
                  onPick={(o) => {
                    const extra = f.autofill?.(o);
                    if (extra)
                      setV((old) => ({
                        ...old,
                        ...Object.fromEntries(Object.entries(extra).filter(([k]) => !old[k]?.trim())),
                      }));
                  }}
                />
              ) : f.type === "textarea" ? (
                <textarea className="input" rows={2} value={v[f.key]} onChange={(e) => set(f.key, e.target.value)} />
              ) : (
                <input
                  className="input"
                  type={f.type ?? "text"}
                  value={v[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
              {f.ai && (
                <button
                  type="button"
                  className="btn ai-fill"
                  disabled={!v[f.key]?.trim()}
                  onClick={() => {
                    onClose();
                    nav(aiAddHref(v[f.key]));
                  }}
                >
                  Заполнить с ИИ ✦
                </button>
              )}
            </span>
          </label>
        ))}
      </div>
      {err && <div className="err">{err}</div>}
      <div className="actions">
        <button className="btn" onClick={onClose}>
          Отмена
        </button>
        <button className="btn primary" disabled={busy} onClick={submit}>
          {busy ? "Сохранение…" : submitLabel}
        </button>
      </div>
    </Modal>
  );
}
