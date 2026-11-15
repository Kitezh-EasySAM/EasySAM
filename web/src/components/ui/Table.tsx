import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

export function Pager({ page, pages, onChange }: { page: number; pages: number; onChange: (p: number) => void }) {
  if (pages <= 1) return null;
  const set = new Set([1, 2, pages - 1, pages, page - 1, page, page + 1]);
  const list = [...set].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out: (number | "…")[] = [];
  list.forEach((p, i) => {
    if (i && p - list[i - 1] > 1) out.push("…");
    out.push(p);
  });
  return (
    <div className="pager">
      <button
        className="step"
        disabled={page === 1}
        onClick={() => onChange(page - 1)}
        aria-label="Предыдущая страница"
      >
        ‹ Назад
      </button>
      {out.map((p, i) =>
        p === "…" ? (
          <span key={`gap-${i}`} className="faint">
            …
          </span>
        ) : (
          <button
            key={p}
            className={p === page ? "cur" : ""}
            aria-current={p === page ? "page" : undefined}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        ),
      )}
      <button
        className="step"
        disabled={page === pages}
        onClick={() => onChange(page + 1)}
        aria-label="Следующая страница"
      >
        Вперёд ›
      </button>
    </div>
  );
}

// ---- размер страницы: общий для всех таблиц, запоминается (по умолчанию 100)
export const PAGE_SIZES = [25, 50, 100, 200] as const;
const sizeListeners = new Set<(n: number) => void>();
let pageSizeValue = (() => {
  try {
    const n = Number(localStorage.getItem("sam_page_size"));
    return PAGE_SIZES.includes(n as 100) ? n : 100;
  } catch {
    return 100;
  }
})();

export function usePageSize(): [number, (n: number) => void] {
  const [n, setN] = useState(pageSizeValue);
  useEffect(() => {
    sizeListeners.add(setN);
    return () => {
      sizeListeners.delete(setN);
    };
  }, []);
  const set = (v: number) => {
    pageSizeValue = v;
    try {
      localStorage.setItem("sam_page_size", String(v));
    } catch {
      /* нет доступа */
    }
    sizeListeners.forEach((f) => f(v));
  };
  return [n, set];
}

/** Низ таблицы: «Показано 1–100 из 187», размер страницы, переключатель страниц. */
export function TableFoot({
  page,
  size,
  total,
  onPage,
  note,
}: {
  page: number;
  size: number;
  total: number;
  onPage: (p: number) => void;
  note?: ReactNode;
}) {
  const [, setSize] = usePageSize();
  const from = total ? (page - 1) * size + 1 : 0,
    to = Math.min(total, page * size);
  return (
    <div className="card-foot">
      <span>
        Показано {from}–{to} из {total.toLocaleString("ru-RU")}
        {note ? <> · {note}</> : null}
      </span>
      <span className="foot-right">
        <label className="size-pick">
          по{" "}
          <select
            value={size}
            onChange={(e) => {
              setSize(+e.target.value);
              onPage(1);
            }}
          >
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <Pager page={page} pages={Math.max(1, Math.ceil(total / size))} onChange={onPage} />
      </span>
    </div>
  );
}

export function pageSlice<T>(rows: T[], page: number, size: number) {
  return { slice: rows.slice((page - 1) * size, page * size), pages: Math.max(1, Math.ceil(rows.length / size)) };
}

/** Кнопка скачивания файла с сервера (по сессии): показывает «Готовлю…», ошибку — во всплывающем title и alert. */

/**
 * Строка таблицы, которая открывает карточку: щелчок, а с клавиатуры — Tab до строки и Enter или пробел.
 * `<tr {...rowLinkProps(() => nav(...))}>`
 */
export function rowLinkProps(onOpen: () => void) {
  return {
    className: "click",
    tabIndex: 0,
    role: "link",
    onClick: onOpen,
    onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onOpen();
      }
    },
  } as const;
}
