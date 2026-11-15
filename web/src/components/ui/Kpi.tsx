import type { ReactNode } from "react";

export function Kpi({
  label,
  value,
  tone,
  small,
  onClick,
  active,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "red" | "amber" | "green" | "faint";
  small?: boolean;
  onClick?: () => void;
  active?: boolean;
  hint?: string;
}) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className={`value ${small ? "sm" : ""} ${tone === "faint" ? "faint" : (tone ?? "")}`}>{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </>
  );
  return onClick ? (
    <button type="button" className={`kpi pick ${active ? "on" : ""}`} aria-pressed={!!active} onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="kpi">{body}</div>
  );
}
