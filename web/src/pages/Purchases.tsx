import { useMemo, useState } from "react";
import { api } from "../api/client.ts";
import { ImportButton } from "../components/ImportBox.tsx";
import { useApi } from "../api/hooks.ts";
import { useSuggestions } from "../api/suggest.ts";
import type { CatalogItem, LicenseType, Purchase, PurchasesSummary } from "../api/types.ts";
import {
  Badge,
  Dash,
  ErrorBox,
  type FieldDef,
  ConfirmModal,
  FormModal,
  Kpi,
  Loading,
  pageSlice,
  TableFoot,
  Tabs,
  usePageSize,
} from "../components/ui/index.ts";
import { dateRu, num, rub } from "../format.ts";

type Tab = "purchases" | "types";
const LABEL = { perpetual: "Бессрочно", active: "Действует", expiring: "Истекает", expired: "Просрочена" } as const;
const TONE = { perpetual: "blue", active: "green", expiring: "amber", expired: "red" } as const;
const KINDS = ["commercial", "freeware", "shareware", "open_source", "trial"] as const;
const boolOpts = [
  { value: "", label: "не определено" },
  { value: "yes", label: "Да" },
  { value: "no", label: "Нет" },
];

export default function Purchases() {
  const list = useApi<Purchase[]>("/api/purchases");
  const sum = useApi<PurchasesSummary>("/api/purchases/summary");
  const types = useApi<LicenseType[]>("/api/license-types");
  const catalog = useApi<{ items: CatalogItem[] }>("/api/catalog?limit=500", false);
  const [tab, setTab] = useState<Tab>("purchases");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [PAGE] = usePageSize();
  const [adding, setAdding] = useState<"purchase" | "type" | null>(null);
  const [removing, setRemoving] = useState<Purchase | null>(null);
  const sug = useSuggestions(adding !== null);

  const purchaseFields: FieldDef[] = [
    {
      key: "catalog_id",
      label: "ПО из каталога",
      type: "search",
      required: true,
      placeholder: "Начните вводить название ПО",
      options: (catalog.data?.items ?? []).map((c) => ({ value: String(c.id), label: c.name })),
    },
    { key: "seats", label: "Куплено мест", type: "number", required: true, placeholder: "25" },
    { key: "unit_price", label: "Цена места, ₽", type: "number", placeholder: "15000" },
    { key: "valid_until", label: "Действует до", type: "date", hint: "пусто — бессрочно" },
    { key: "contract", label: "Номер договора", placeholder: "Д-2026/041", suggestions: sug.contracts },
  ];
  const addPurchase = async (v: Record<string, string>) => {
    await api.post("/api/purchases", {
      catalog_id: +v.catalog_id,
      seats: +v.seats,
      unit_price: v.unit_price.trim() ? +v.unit_price : 0,
      valid_until: v.valid_until || null,
      contract: v.contract.trim() || null,
    });
    list.reload();
    sum.reload();
  };

  const typeFields: FieldDef[] = [
    {
      key: "name",
      label: "Название соглашения",
      required: true,
      placeholder: "GPL v3",
      suggestions: sug.licenseNames,
      autofill: (o) => ({ kind: o.value }),
    },
    { key: "kind", label: "Тип", type: "select", options: KINDS.map((k) => ({ value: k, label: k })) },
    { key: "commercial_use", label: "Коммерческое использование", type: "select", options: boolOpts },
    { key: "copyleft", label: "Copyleft", type: "select", options: boolOpts },
  ];
  const addType = async (v: Record<string, string>) => {
    const bool = (s: string) => (s === "" ? null : s === "yes");
    await api.post("/api/license-types", {
      name: v.name.trim(),
      kind: v.kind,
      commercial_use: bool(v.commercial_use),
      copyleft: bool(v.copyleft),
    });
    types.reload();
  };

  const all = useMemo(() => list.data ?? [], [list.data]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return all.filter(
      (p) => !s || p.catalog_name.toLowerCase().includes(s) || (p.contract ?? "").toLowerCase().includes(s),
    );
  }, [all, q]);
  const typeRows = useMemo(
    () => (types.data ?? []).filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase())),
    [types.data, q],
  );
  const purchaseSlice = pageSlice(rows, page, PAGE).slice;
  const typeSlice = pageSlice(typeRows, page, PAGE).slice;

  const active = all.filter((p) => p.active);
  const taken = [...new Map(active.map((p) => [p.catalog_id, p.installed])).values()].reduce((a, b) => a + b, 0);
  const soon = all.filter((p) => p.active && p.days_left != null && p.days_left <= 90).length;
  const expired = all.filter((p) => p.status === "expired").length;

  if (list.error)
    return (
      <div className="page">
        <ErrorBox text={list.error} />
      </div>
    );
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Закупки</h1>
          <div className="sub">{all.length} договоров</div>
        </div>
        <div className="actions">
          {tab === "types" && (
            <button className="btn admin-only" onClick={() => setAdding("type")}>
              Добавить тип
            </button>
          )}
          {tab === "purchases" && <ImportButton kind="purchases" onDone={() => list.reload()} />}
          <button className="btn primary admin-only" onClick={() => setAdding("purchase")}>
            Добавить закупку
          </button>
        </div>
      </div>

      <div className="kpis">
        <Kpi label="Мест куплено" value={num(active.reduce((a, p) => a + p.seats, 0))} />
        <Kpi label="Мест занято" value={num(taken)} />
        <Kpi label="Сумма действующих договоров" value={sum.data ? rub(sum.data.active_cost) : "…"} tone="amber" />
        <Kpi label="Истекают в 90 дней" value={soon} tone={soon ? "amber" : undefined} />
        <Kpi label="Просрочено" value={expired} tone={expired ? "red" : undefined} />
      </div>

      <div className="card">
        <Tabs<Tab>
          value={tab}
          onChange={(t) => {
            setTab(t);
            setPage(1);
            setQ("");
          }}
          items={[
            { id: "purchases", label: "Закупки", n: all.length },
            { id: "types", label: "Типы лицензий", n: types.data?.length },
          ]}
          end={
            <input
              className="input"
              placeholder="Поиск"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          }
        />
        {list.loading ? (
          <Loading />
        ) : tab === "purchases" ? (
          <table className="t">
            <thead>
              <tr>
                <th>ПО</th>
                <th>Договор</th>
                <th>Занято / куплено</th>
                <th className="num">Цена места, ₽</th>
                <th className="num">Сумма, ₽</th>
                <th>Действует до</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {purchaseSlice.map((p) => {
                const ratio = p.seats ? p.used / p.seats : 0;
                const tone = ratio > 1 ? "red" : ratio < 0.9 ? "amber" : "";
                return (
                  <tr key={p.id} className={p.active ? undefined : "faded"}>
                    <td className="strong">{p.catalog_name}</td>
                    <td className="mono muted">{p.contract ?? <Dash />}</td>
                    <td>
                      <div className="seats">
                        <div className="bar">
                          <i className={tone} style={{ width: `${Math.min(100, ratio * 100)}%` }} />
                        </div>
                        <span>
                          <span
                            className={`strong ${ratio > 1 ? "red" : ""}`}
                            title={`всего установок этой позиции: ${p.installed}`}
                          >
                            {p.used}
                          </span>{" "}
                          <span className="muted">/ {p.seats}</span>
                        </span>
                      </div>
                    </td>
                    <td className="num">{num(p.unit_price)}</td>
                    <td className="num strong">{num(p.total_cost)}</td>
                    <td className={p.status === "expired" ? "red" : p.status === "expiring" ? "amber" : "muted"}>
                      {p.valid_until ? dateRu(p.valid_until) : "бессрочно"}
                    </td>
                    <td>
                      <Badge tone={TONE[p.status]}>{LABEL[p.status]}</Badge>
                    </td>
                    <td className="right">
                      <button
                        className="icon-x admin-only"
                        aria-label={`Удалить закупку «${p.catalog_name}»`}
                        onClick={() => setRemoving(p)}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <table className="t">
            <thead>
              <tr>
                <th>Соглашение</th>
                <th>Тип</th>
                <th>Коммерческое использование</th>
                <th>Copyleft</th>
                <th className="num">ПО в каталоге</th>
              </tr>
            </thead>
            <tbody>
              {typeSlice.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="mono muted">{t.kind}</td>
                  <td>
                    {t.commercial_use == null ? (
                      <span className="muted">не определено</span>
                    ) : t.commercial_use ? (
                      "Да"
                    ) : (
                      <span className="red">Нет</span>
                    )}
                  </td>
                  <td>{t.copyleft == null ? <Dash /> : t.copyleft ? "Да" : "Нет"}</td>
                  <td className="num">{t.software_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <TableFoot
          page={page}
          size={PAGE}
          total={tab === "purchases" ? rows.length : typeRows.length}
          onPage={setPage}
        />
      </div>

      {adding === "purchase" && (
        <FormModal
          title="Добавить закупку"
          fields={purchaseFields}
          onClose={() => setAdding(null)}
          onSubmit={addPurchase}
        />
      )}
      {adding === "type" && (
        <FormModal
          title="Добавить тип лицензии"
          fields={typeFields}
          onClose={() => setAdding(null)}
          onSubmit={addType}
        />
      )}
      {removing && (
        <ConfirmModal
          title={`Удалить закупку «${removing.catalog_name}»${removing.contract ? ` (${removing.contract})` : ""}?`}
          confirmLabel="Удалить"
          danger
          onConfirm={async () => {
            await api.del(`/api/purchases/${removing.id}`);
            list.reload();
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
