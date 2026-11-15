import { useRef, type ReactNode } from "react";
import { useFadeSiblings, useInk } from "./motion.ts";

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  end,
}: {
  items: { id: T; label: string; n?: number }[];
  value: T;
  onChange: (id: T) => void;
  end?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useInk(ref, value);
  useFadeSiblings(ref, value);
  return (
    <div className="tabs ink" ref={ref}>
      {items.map((t) => (
        <button key={t.id} className={`tab ${t.id === value ? "active" : ""}`} onClick={() => onChange(t.id)}>
          {t.label}
          {t.n != null && <span className="n">{t.n}</span>}
        </button>
      ))}
      {end && <span className="end">{end}</span>}
    </div>
  );
}
