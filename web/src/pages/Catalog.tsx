import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../api/client.ts";
import { useApi } from "../api/hooks.ts";
import { useSuggestions } from "../api/suggest.ts";
import { EulaCheck } from "../components/Eula.tsx";
import { ImportButton } from "../components/ImportBox.tsx";
import { UnmatchedList } from "../components/UnmatchedList.tsx";
import type { CatalogItem, InternalStatus, LicenseKind, LicenseType, Unmatched } from "../api/types.ts";
import {
  Badge,
  Dash,
  ErrorBox,
  type FieldDef,
  FormModal,
  Loading,
  Modal,
  TableFoot,
  Tabs,
  usePageSize,
  rowLinkProps,
} from "../components/ui/index.ts";
import { KIND_LABEL, num } from "../format.ts";

type Tab = "all" | InternalStatus;
const KINDS: LicenseKind[] = ["commercial", "freeware", "shareware", "open_source", "trial"];
const LABEL = { current: "Актуальный", outdated: "Устаревший", forbidden: "Запрещён" } as const;
const TONE = { current: "green", outdated: "amber", forbidden: "red" } as const;

export default function Catalog() {
  const nav = useNavigate();
  const unmatched = useLocation().pathname.endsWith("/unmatched"); // вкладка «Нераспределённое» (/catalog/unmatched)
  const unknown = useApi<Unmatched>("/api/unmatched?limit=1");
  const [tab, setTab] = useState<Tab>(() => {
    const st = new URLSearchParams(location.search).get("status"); // ссылка с дашборда: ?status=forbidden
    return (["current", "outdated", "forbidden"] as string[]).includes(st ?? "") ? (st as Tab) : "all";
  });
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [kind, setKind] = useState("");
  const [ru, setRu] = useState("");
  const [page, setPage] = useState(1);
  const [PAGE] = usePageSize();
  useEffect(() => {
    const t = setTimeout(() => {
      setDq(q);
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const qs = new URLSearchParams({ limit: "500" });
  if (dq) qs.set("q", dq);
  if (tab !== "all") qs.set("status", tab);
  if (kind) qs.set("kind", kind);
  const list = useApi<{ total: number; items: CatalogItem[] }>(`/api/catalog?${qs}`);
  const counts = useApi<{ total: number; items: CatalogItem[] }>("/api/catalog?limit=500");
  const types = useApi<LicenseType[]>("/api/license-types", false);
  const [adding, setAdding] = useState(false);
  const [sort, setSort] = useState<"installed" | "name">("installed"); // щелчок по заголовку колонки
  const [checking, setChecking] = useState(false);
  const sug = useSuggestions(adding);

  const addFields: FieldDef[] = [
    {
      key: "name",
      label: "Название или ссылка",
      required: true,
      ai: true,
      suggestions: sug.newSoftware,
      autofill: (o) => ({ vendor: o.value }),
    },
    { key: "vendor", label: "Вендор", placeholder: "Microsoft Corporation", suggestions: sug.vendors },
    {
      key: "license_kind",
      label: "Тип лицензии",
      type: "select",
      value: "open_source",
      options: KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
    },
    {
      key: "internal_status",
      label: "Статус",
      type: "select",
      value: "current",
      options: [
        { value: "current", label: "Актуальный" },
        { value: "outdated", label: "Устаревший" },
        { value: "forbidden", label: "Запрещён" },
      ],
    },
    {
      key: "license_type_id",
      label: "Лицензионное соглашение",
      type: "select",
      options: [
        { value: "", label: "— не указано —" },
        ...(types.data ?? []).map((t) => ({ value: String(t.id), label: t.name })),
      ],
    },
    {
      key: "in_ru_registry",
      label: "Реестр российского ПО",
      type: "select",
      options: [
        { value: "", label: "не определено" },
        { value: "yes", label: "в реестре" },
        { value: "no", label: "не в реестре" },
      ],
    },
    {
      key: "min_version",
      label: "Нужная версия",
      placeholder: "16.0",
      hint: "у ПК с другой версией — жёлтая строка (ниже — устарело, выше — обновилось)",
    },
    { key: "list_price", label: "Цена места, ₽", type: "number", placeholder: "15000" },
    { key: "registry_section", label: "Раздел реестра", half: true, placeholder: "Раздел 02" },
    { key: "registry_class", label: "Класс", half: true, placeholder: "04.01" },
    { key: "purpose", label: "Назначение", type: "textarea", placeholder: "Текстовый процессор" },
  ];
  const addItem = async (v: Record<string, string>) => {
    await api.post("/api/catalog", {
      name: v.name.trim(),
      vendor: v.vendor.trim() || null,
      purpose: v.purpose.trim() || null,
      license_kind: v.license_kind,
      internal_status: v.internal_status,
      license_type_id: v.license_type_id ? +v.license_type_id : null,
      min_version: v.min_version.trim() || null,
      list_price: v.list_price.trim() ? +v.list_price : null,
      in_ru_registry: v.in_ru_registry === "" ? null : v.in_ru_registry === "yes",
      registry_section: v.registry_section.trim() || null,
      registry_class: v.registry_class.trim() || null,
    });
    list.reload();
    counts.reload();
  };

  const all = counts.data?.items ?? [];
  const n = (s: InternalStatus) => all.filter((i) => i.internal_status === s).length;
  const items = (list.data?.items ?? [])
    .filter((i) => !ru || (ru === "yes" ? i.in_ru_registry === true : i.in_ru_registry !== true))
    .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name, "ru") : b.installed - a.installed));
  const slice = items.slice((page - 1) * PAGE, page * PAGE);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Каталог ПО</h1>
          <div className="sub">{all.length} позиций</div>
        </div>
        <div className="actions">
          <button className="btn admin-only" onClick={() => setChecking(true)}>
            Проверить лицензию ✦
          </button>
          <ImportButton
            kind="catalog"
            onDone={() => {
              list.reload();
              counts.reload();
            }}
          />
          <button className="btn primary admin-only" onClick={() => setAdding(true)}>
            Добавить ПО
          </button>
        </div>
      </div>

      <div className="page-tabs">
        <Tabs
          items={[
            { id: "list", label: "Программы", n: all.length },
            { id: "unmatched", label: "Нераспределённое", n: unknown.data?.total },
          ]}
          value={unmatched ? "unmatched" : "list"}
          onChange={(t) => nav(t === "unmatched" ? "/catalog/unmatched" : "/catalog")}
        />
      </div>
      {unmatched ? (
        <UnmatchedList />
      ) : (
        <div className="card">
          <Tabs<Tab>
            value={tab}
            onChange={(t) => {
              setTab(t);
              setPage(1);
            }}
            items={[
              { id: "all", label: "Все", n: all.length },
              { id: "current", label: "Актуальные", n: n("current") },
              { id: "outdated", label: "Устаревшие", n: n("outdated") },
              { id: "forbidden", label: "Запрещённые", n: n("forbidden") },
            ]}
          />
          <div className="toolbar">
            <input className="input" placeholder="Поиск" value={q} onChange={(e) => setQ(e.target.value)} />
            <select
              className="input"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Тип лицензии: все</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={ru}
              onChange={(e) => {
                setRu(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Российский реестр: все</option>
              <option value="yes">В реестре</option>
              <option value="no">Не в реестре</option>
            </select>
          </div>
          {list.loading ? (
            <Loading />
          ) : list.error ? (
            <ErrorBox text={list.error} />
          ) : (
            <table className="t">
              <thead>
                <tr>
                  <th aria-sort={sort === "name" ? "ascending" : "none"}>
                    <button type="button" className="th-sort" onClick={() => setSort("name")}>
                      Название / вендор{sort === "name" ? " ↓" : ""}
                    </button>
                  </th>
                  <th>Раздел реестра</th>
                  <th>Реестр РФ</th>
                  <th>Лицензия</th>
                  <th>Соглашение</th>
                  <th>Мин. версия</th>
                  <th className="num" aria-sort={sort === "installed" ? "descending" : "none"}>
                    <button type="button" className="th-sort" onClick={() => setSort("installed")}>
                      Установлено / мест{sort === "installed" ? " ↓" : ""}
                    </button>
                  </th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((i) => {
                  const bad = i.seats > 0 && i.installed > i.seats;
                  return (
                    <tr key={i.id} {...rowLinkProps(() => nav(`/catalog/${i.id}`))}>
                      <td>
                        <div className="strong">{i.name}</div>
                        <div className="sub-line">{i.vendor}</div>
                      </td>
                      <td className="clip" title={i.registry_section ?? undefined}>
                        {i.registry_section?.replace(" - ", " · ") ?? <Dash />}
                      </td>
                      <td>
                        {i.in_ru_registry ? <span className="reg">в реестре</span> : <span className="muted">Нет</span>}
                      </td>
                      <td className="muted">{KIND_LABEL[i.license_kind] ?? i.license_kind}</td>
                      <td className="muted">{i.license_type_name ?? <Dash />}</td>
                      <td className="mono">{i.min_version ?? <Dash />}</td>
                      <td className="num">
                        <span
                          className={`strong ${bad || (i.internal_status === "forbidden" && i.installed) ? "red" : ""}`}
                        >
                          {num(i.installed)}
                        </span>
                        {i.seats > 0 || i.internal_status === "forbidden" ? (
                          <span className="muted"> / {i.seats}</span>
                        ) : null}
                      </td>
                      <td>
                        <Badge tone={TONE[i.internal_status]}>{LABEL[i.internal_status]}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <TableFoot page={page} size={PAGE} total={items.length} onPage={setPage} />
        </div>
      )}

      {checking && (
        <Modal title="Проверка лицензии (EULA)" wide onClose={() => setChecking(false)}>
          <EulaCheck autoFocus onDone={() => list.reload()} />
        </Modal>
      )}
      {adding && (
        <FormModal
          title="Добавить ПО в каталог"
          fields={addFields}
          onClose={() => setAdding(false)}
          onSubmit={addItem}
        />
      )}
    </div>
  );
}
