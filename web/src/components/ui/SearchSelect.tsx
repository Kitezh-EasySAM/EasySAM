import { useEffect, useId, useRef, useState } from "react";
import { focusOnMount } from "./focus.ts";

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Выбор из длинного списка: поле поиска + выпадающий список поверх (не сдвигает строки) + × очистить.
 * exclude — значения, которые уже показаны рядом (напр. подсказки) — в списке не дублируются.
 */
export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = "Найти…",
  exclude = [],
  clearable = true,
  compact,
  autoFocus,
}: {
  options: Option[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  exclude?: string[];
  clearable?: boolean;
  compact?: boolean;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false);
        setQ("");
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const s = q.trim().toLowerCase();
  const list = options
    .filter(
      (o) =>
        !exclude.includes(o.value) && (!s || o.label.toLowerCase().includes(s) || o.hint?.toLowerCase().includes(s)),
    )
    .slice(0, 200);
  const choose = (o: Option) => {
    onChange(o.value);
    setOpen(false);
    setQ("");
  };
  return (
    <div className={`ss ${compact ? "compact" : ""}`} ref={box}>
      <input
        className="input"
        placeholder={selected ? selected.label : placeholder}
        value={open ? q : (selected?.label ?? "")}
        ref={autoFocus ? focusOnMount : undefined}
        onFocus={() => {
          setOpen(true);
          setHi(0);
        }}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          setHi(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, list.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter" && list[hi]) {
            e.preventDefault();
            choose(list[hi]);
          } else if (e.key === "Escape") {
            if (open) e.preventDefault();
            setOpen(false);
            setQ("");
            (e.target as HTMLInputElement).blur();
          }
        }}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
      />
      {clearable && (value || (open && q)) && (
        <button
          type="button"
          className="ss-x"
          aria-label="Очистить"
          title="Очистить"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (q) setQ("");
            else {
              onChange("");
              setOpen(false);
            }
          }}
        >
          ×
        </button>
      )}
      {open && (
        <div className="ss-list" role="listbox" id={listId}>
          {list.length ? (
            list.map((o, i) => (
              <div
                key={o.value}
                role="option"
                tabIndex={-1}
                aria-selected={o.value === value}
                className={`ss-opt ${i === hi ? "hi" : ""} ${o.value === value ? "sel" : ""}`}
                onMouseEnter={() => setHi(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
              >
                <span>{o.label}</span>
                {o.hint && <span className="faint">{o.hint}</span>}
              </div>
            ))
          ) : (
            <div className="ss-empty">Ничего не найдено</div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Поле с автокомплитом: свободный ввод + подсказки из уже введённых данных (отделы, вендоры, названия из «Неопознанного»).
 * onPick — выбрали подсказку (можно дозаполнить соседние поля).
 */
export function AutoInput({
  value,
  onChange,
  options,
  onPick,
  placeholder,
  type,
  autoFocus,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  onPick?: (o: Option) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
  maxLength?: number;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const [hi, setHi] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const s = value.trim().toLowerCase();
  const list = options
    .filter(
      (o) =>
        o.label.toLowerCase() !== s && (!s || o.label.toLowerCase().includes(s) || o.hint?.toLowerCase().includes(s)),
    )
    .sort((a, b) => Number(!a.label.toLowerCase().startsWith(s)) - Number(!b.label.toLowerCase().startsWith(s)))
    .slice(0, 8);
  const choose = (o: Option) => {
    onChange(o.label);
    onPick?.(o);
    setOpen(false);
    setHi(-1);
  };
  const mark = (label: string) => {
    const i = s ? label.toLowerCase().indexOf(s) : -1;
    return i < 0 ? (
      label
    ) : (
      <>
        {label.slice(0, i)}
        <b>{label.slice(i, i + s.length)}</b>
        {label.slice(i + s.length)}
      </>
    );
  };
  return (
    <div className="ss" ref={box}>
      <input
        className="input"
        type={type ?? "text"}
        value={value}
        placeholder={placeholder}
        ref={autoFocus ? focusOnMount : undefined}
        maxLength={maxLength}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && list.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setHi(-1);
        }}
        onKeyDown={(e) => {
          if (!open || !list.length) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setHi((h) => Math.min(h + 1, list.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setHi((h) => Math.max(h - 1, -1));
          } else if ((e.key === "Enter" || e.key === "Tab") && hi >= 0) {
            e.preventDefault();
            choose(list[hi]);
          } else if (e.key === "Escape") {
            if (open) e.preventDefault();
            setOpen(false);
          }
        }}
      />
      {open && list.length > 0 && (
        <div className="ss-list" role="listbox" id={listId}>
          <div className="ss-cap">Подсказки</div>
          {list.map((o, i) => (
            <div
              key={o.value + o.label}
              role="option"
              tabIndex={-1}
              aria-selected={i === hi}
              className={`ss-opt ${i === hi ? "hi" : ""}`}
              onMouseEnter={() => setHi(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(o);
              }}
            >
              <span>{mark(o.label)}</span>
              {o.hint && <span className="faint">{o.hint}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
