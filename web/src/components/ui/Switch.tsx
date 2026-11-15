import type { ReactNode } from "react";

export function Switch({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** Модальное окно: закрывается по Escape, клику по фону и кнопкам внутри. Escape, «съеденный» выпадающим списком, окно не закрывает. */
