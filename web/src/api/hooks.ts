import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./client.ts";
import { onStream } from "./stream.ts";

/**
 * Загрузка данных; `live` — перезапрашивать при изменениях на сервере (SSE):
 * всегда «ingest» и «changed», плюс события из `extraEvents` (напр. «agent» — сердцебиение агента).
 */
export function useApi<T>(path: string | null, live = true, extraEvents: string[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  // загружено для какого адреса: «загрузка» = адрес сменился, а ответа для него ещё нет (без setState в эффекте)
  const [donePath, setDonePath] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(() => {
    if (!path) return;
    const n = ++seq.current;
    api.get<T>(path).then(
      (d) => {
        if (n === seq.current) {
          setData(d);
          setError(null);
          setDonePath(path);
        }
      },
      (e) => {
        if (n === seq.current) {
          setError(e.message);
          setDonePath(path);
        }
      },
    );
  }, [path]);

  const key = extraEvents.join(",");
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!live) return;
    const offs = ["ingest", "changed", ...key.split(",").filter(Boolean)].map((t) => onStream(t, load));
    return () => offs.forEach((o) => o());
  }, [live, load, key]);

  const loading = !!path && donePath !== path;
  return { data, error, loading, reload: load };
}
