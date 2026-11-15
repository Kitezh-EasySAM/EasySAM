import type { ReactNode } from "react";

export function Badge({
  tone,
  dot,
  children,
}: {
  tone?: "red" | "amber" | "green" | "blue";
  dot?: boolean;
  children: ReactNode;
}) {
  return <span className={`badge ${tone ?? ""} ${dot ? "dot" : ""}`}>{children}</span>;
}
