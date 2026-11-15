import { Link } from "react-router-dom";
import { aiAddHref } from "../format.ts";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client.ts";
import { useApi } from "../api/hooks.ts";
import type { CatalogItem, Unmatched as U } from "../api/types.ts";
import { Dash, ErrorBox, Loading, SearchSelect, TableFoot, usePageSize } from "./ui/index.ts";
import { num } from "../format.ts";

/** Подсказка ИИ (POST /api/unmatched/ai-suggest): позиция каталога, «компонент» или «не знаю». Привязку подтверждает человек. */
interface AiHint {
  norm_name: string;
  verdict: "catalog" | "component" | "unknown";
  catalog_id: number | null;
  name: string | null;
  reason: string;
}

/** Вкладка «Нераспределённое» в каталоге ПО (/catalog/unmatched): названия с ПК, которых нет в каталоге. */
export function UnmatchedList() {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [page, setPage] = useState(1);
  const [PAGE] = usePageSize();
  const [err, setErr] = useState("");
  const ai = useApi<{ llm: boolean }>("/api/ai/info", false);
  const [hints, setHints] = useState<Record<string, AiHint>>({});
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => {
      setDq(q);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, loading, reload } = useApi<U>(
    `/api/unmatched?limit=${PAGE}&offset=${(page - 1) * PAGE}&q=${encodeURIComponent(dq)}`,
  );
  const catalog = useApi<{ items: CatalogItem[] }>("/api/catalog?limit=500", false);

  const catalogOptions = useMemo(
    () => (catalog.data?.items ?? []).map((c) => ({ value: String(c.id), label: c.name, hint: c.vendor ?? undefined })),
    [catalog.data],
  );
  const askAi = async () => {
    const names = (data?.items ?? []).map((i) => i.norm_name).slice(0, 30);
    if (!names.length) return;
    setAsking(true);
    setErr("");
    try {
      const r = await api.post<{ items: AiHint[] }>("/api/unmatched/ai-suggest", { norm_names: names });
      setHints((h) => ({ ...h, ...Object.fromEntries(r.items.map((x) => [x.norm_name, x])) }));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setAsking(false);
  };
  const resolve = (body: object) =>
    api.post("/api/unmatched/resolve", body).then(
      () => {
        setErr("");
        reload();
      },
      (e) => setErr(e.message),
    );

  return (
    <>
      {err && <div className="err">{err}</div>}
      <div className="card">
        <div className="toolbar">
          <input className="input" placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} />
          {data && (
            <span className="muted">
              {num(data.total)} названий · {num(data.total_installations)} установок
            </span>
          )}
          {ai.data?.llm && (
            <button className="btn admin-only" disabled={asking || !data?.items.length} onClick={askAi}>
              {asking ? "ИИ думает…" : "Подсказать ИИ ✦"}
            </button>
          )}
        </div>
        {loading && !data ? (
          <Loading />
        ) : error ? (
          <ErrorBox text={error} />
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>Название</th>
                <th>Издатель</th>
                <th className="num">ПК</th>
                <th>Привязать к каталогу</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(data?.items ?? []).map((i) => (
                <tr key={i.norm_name}>
                  <td>{i.example_raw_name}</td>
                  <td className="muted">{i.publisher ?? <Dash />}</td>
                  <td className="num">{i.devices}</td>
                  <td>
                    <span className="admin-only inline-row">
                      {hints[i.norm_name]?.verdict === "catalog" &&
                        !i.suggestions.some((s) => s.catalog_id === hints[i.norm_name].catalog_id) && (
                          <button
                            className="btn ai-hint xs"
                            title={hints[i.norm_name].reason}
                            onClick={() =>
                              resolve({ norm_names: [i.norm_name], catalog_id: hints[i.norm_name].catalog_id })
                            }
                          >
                            ✦ {hints[i.norm_name].name}
                          </button>
                        )}
                      {hints[i.norm_name]?.verdict === "component" && (
                        <span className="ai-note" title={hints[i.norm_name].reason}>
                          ✦ компонент — можно не учитывать
                        </span>
                      )}
                      {hints[i.norm_name]?.verdict === "unknown" && (
                        <span className="ai-note" title={hints[i.norm_name].reason}>
                          ✦ в каталоге нет
                        </span>
                      )}
                      {i.suggestions.map((s) => (
                        <button
                          key={s.catalog_id}
                          className="btn xs"
                          onClick={() => resolve({ norm_names: [i.norm_name], catalog_id: s.catalog_id })}
                        >
                          {s.name} · {Math.round(s.score * 100)}%
                        </button>
                      ))}
                      <SearchSelect
                        compact
                        placeholder="Другое ПО"
                        value=""
                        clearable
                        exclude={i.suggestions.map((s) => String(s.catalog_id))}
                        options={catalogOptions}
                        onChange={(v) => v && resolve({ norm_names: [i.norm_name], catalog_id: +v })}
                      />
                    </span>
                  </td>
                  <td className="right nowrap row-actions">
                    <Link className="btn ai-fill admin-only xs" to={aiAddHref(i.example_raw_name)}>
                      Добавить с ИИ ✦
                    </Link>{" "}
                    <button
                      className="btn admin-only xs"
                      onClick={() => resolve({ norm_names: [i.norm_name], ignore: true })}
                    >
                      Не учитывать
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <TableFoot page={page} size={PAGE} total={data?.total ?? 0} onPage={setPage} />
      </div>
    </>
  );
}
