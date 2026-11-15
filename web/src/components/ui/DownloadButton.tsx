import { useState, type ReactNode } from "react";
import { download } from "../../api/client.ts";

export function DownloadButton({
  href,
  name,
  className = "btn",
  title,
  children,
}: {
  href: string;
  name: string;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await download(href, name);
    } catch (e) {
      alert(`Не удалось скачать: ${e instanceof Error ? e.message : String(e)}`);
    }
    setBusy(false);
  };
  return (
    <button className={className} onClick={run} disabled={busy} title={title}>
      {busy ? "Готовлю…" : children}
    </button>
  );
}
