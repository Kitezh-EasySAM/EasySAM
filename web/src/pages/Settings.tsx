import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api/client.ts";
import { useApi } from "../api/hooks.ts";
import { useSuggestions } from "../api/suggest.ts";
import { NewUserModal, PasswordModal } from "../components/UserForms.tsx";
import { DeployKeyModal, type PoolKey as PoolRow, type PoolProduct } from "../components/DeployKey.tsx";
import { useAuth } from "../api/auth.tsx";
import { InstallsEntry } from "../components/InstallsEntry.tsx";
import { ImportBox } from "../components/ImportBox.tsx";
import { EmployeesTable, KeysTable, UsersTable } from "../components/settings/Tables.tsx";
import type { AppUser, Employee } from "../api/types.ts";
import {
  ErrorBox,
  type FieldDef,
  FormModal,
  Loading,
  TableFoot,
  Tabs,
  usePageSize,
  ConfirmModal,
} from "../components/ui/index.ts";

type Tab = "employees" | "keys" | "installs" | "users";

/** Настройки: сотрудники (вручную и из Excel), ключи лицензий, установки на ПК, пользователи. Программы и закупки — на своих страницах. */
export default function Settings() {
  const { tab: tabParam } = useParams();
  const navTo = useNavigate();
  const { isAdmin } = useAuth();
  const tab: Tab = (["employees", "keys", "installs", "users"] as const).find((t) => t === tabParam) ?? "employees";
  const setTab = (t: Tab) => {
    navTo(t === "employees" ? "/settings" : `/settings/${t}`, { replace: true });
    setPage(1);
    setQ("");
  };
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [size] = usePageSize();
  const [adding, setAdding] = useState(false);
  const [resetFor, setResetFor] = useState<AppUser | null>(null);
  const sug = useSuggestions(adding);
  const [err, setErr] = useState("");

  const emps = useApi<Employee[]>("/api/employees");
  const pool = useApi<PoolRow[]>("/api/license-pool");
  const products = useApi<PoolProduct[]>("/api/license-pool/products", false);
  const prodBy = (id: string) => products.data?.find((p) => p.product === id);
  const [deployFor, setDeployFor] = useState<PoolRow | null>(null);
  const users = useApi<AppUser[]>(isAdmin ? "/api/users" : null, false);
  const reloadAll = () => {
    emps.reload();
    pool.reload();
    if (isAdmin) users.reload();
  };

  const s = q.trim().toLowerCase();
  const has = (...v: (string | null | undefined)[]) => !s || v.some((x) => x?.toLowerCase().includes(s));
  const lists = {
    employees: (emps.data ?? []).filter((e) => has(e.full_name, e.department)),
    keys: (pool.data ?? []).filter((p) => has(p.title, p.product, prodBy(p.product)?.title, p.license_type)),
    users: (users.data ?? []).filter((u) => has(u.login, u.name)),
    installs: [] as unknown[], // своя панель — components/InstallsEntry.tsx
  };
  const rows = lists[tab] as unknown[];
  const slice = rows.slice((page - 1) * size, page * size);
  const cur = { employees: emps, keys: pool, users, installs: emps }[tab];

  // удаление — через окно подтверждения; ошибка сервера (например, «есть связанные записи») показывается в окне
  const [removing, setRemoving] = useState<{ path: string; what: string } | null>(null);
  const remove = (path: string, what: string) => setRemoving({ path, what });

  const forms: Record<
    Exclude<Tab, "users" | "installs">,
    { title: string; fields: FieldDef[]; submit: (v: Record<string, string>) => Promise<void> }
  > = {
    employees: {
      title: "Новый сотрудник",
      fields: [
        { key: "full_name", label: "ФИО", required: true, placeholder: "Иванов Иван Иванович" },
        { key: "department", label: "Отдел", placeholder: "Бухгалтерия", suggestions: sug.departments },
        {
          key: "active",
          label: "Статус",
          type: "select",
          options: [
            { value: "yes", label: "Работает" },
            { value: "no", label: "Уволен" },
          ],
        },
      ],
      submit: async (v) => {
        await api.post("/api/employees", {
          full_name: v.full_name.trim(),
          department: v.department.trim() || null,
          active: v.active !== "no",
        });
      },
    },
    keys: {
      title: "Новый ключ лицензии",
      fields: [
        {
          key: "product",
          label: "Продукт",
          type: "select",
          required: true,
          options: (products.data ?? []).map((p) => ({
            value: p.product,
            label: p.can_deploy ? `${p.title} — раздача на ПК` : `${p.title} — учёт мест`,
          })),
        },
        {
          key: "title",
          label: "Название",
          required: true,
          placeholderFor: (v) => `${prodBy(v.product)?.title ?? "Продукт"}, договор / отдел`,
        },
        {
          key: "license_key",
          label: "Ключ",
          required: true,
          placeholderFor: (v) => prodBy(v.product)?.key_placeholder,
          hintFor: (v) =>
            `${prodBy(v.product)?.key_hint ?? ""}. Хранится только на сервере, на экран — последние 5 символов.`,
        },
        { key: "seats", label: "Мест", type: "number", half: true, value: "1" },
        { key: "valid_until", label: "Действует до", type: "date", hint: "пусто — бессрочно" },
        {
          key: "license_type",
          label: "Вид лицензии",
          half: true,
          placeholder: "серверная / клиентская",
          suggestions: [...new Set((pool.data ?? []).map((p) => p.license_type).filter(Boolean) as string[])].map(
            (v) => ({ value: v, label: v }),
          ),
        },
      ],
      submit: async (v) => {
        await api.post("/api/license-pool", {
          product: v.product,
          title: v.title.trim(),
          license_key: v.license_key.trim(),
          seats: +v.seats || 1,
          valid_until: v.valid_until || null,
          license_type: v.license_type.trim() || null,
        });
      },
    },
  };

  const toggleUser = async (u: AppUser, patch: Partial<AppUser>) => {
    setErr("");
    try {
      await api.patch(`/api/users/${u.id}`, patch);
      users.reload();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  const tabs = [
    { id: "employees" as const, label: "Сотрудники", n: emps.data?.length },
    { id: "keys" as const, label: "Ключи лицензий", n: pool.data?.length },
    { id: "installs" as const, label: "Установки на ПК" },
    ...(isAdmin ? [{ id: "users" as const, label: "Пользователи", n: users.data?.length }] : []),
  ];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Настройки</h1>
        </div>
        {isAdmin && tab !== "installs" && (
          <div className="actions">
            <button className="btn primary" onClick={() => setAdding(true)}>
              + {tab === "users" ? "Новый пользователь" : "Добавить вручную"}
            </button>
          </div>
        )}
      </div>

      <div
        className="grid-2"
        style={{
          gridTemplateColumns:
            tab === "keys" || tab === "users" || tab === "installs" || !isAdmin
              ? "minmax(0,1fr)"
              : "minmax(0,1fr) 380px",
        }}
      >
        <div className="card">
          <Tabs items={tabs} value={tab} onChange={setTab} />
          {tab === "installs" ? (
            <InstallsEntry isAdmin={isAdmin} />
          ) : (
            <>
              <div className="toolbar">
                <input
                  className="input"
                  placeholder="Поиск"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setPage(1);
                  }}
                />
                {err && <span className="red small">{err}</span>}
              </div>
              {cur.error ? (
                <ErrorBox text={cur.error} />
              ) : cur.loading && !cur.data ? (
                <Loading />
              ) : (
                <div className="t-scroll">
                  <table className="t">
                    {tab === "employees" && <EmployeesTable rows={slice as Employee[]} onRemove={remove} />}
                    {tab === "users" && (
                      <UsersTable
                        rows={slice as AppUser[]}
                        onRemove={remove}
                        onToggle={toggleUser}
                        onReset={setResetFor}
                      />
                    )}
                    {tab === "keys" && (
                      <KeysTable
                        rows={slice as PoolRow[]}
                        onRemove={remove}
                        productTitle={(id) => prodBy(id)?.title ?? id}
                        canDeploy={(id) => !!prodBy(id)?.can_deploy}
                        onDeploy={setDeployFor}
                      />
                    )}
                  </table>
                  {!rows.length && (
                    <div className="empty">
                      {q ? "Ничего не найдено" : "Пока пусто — добавьте вручную или загрузите Excel"}
                    </div>
                  )}
                </div>
              )}
              <TableFoot page={page} size={size} total={rows.length} onPage={setPage} />
            </>
          )}
        </div>

        {tab !== "keys" && tab !== "users" && tab !== "installs" && isAdmin && (
          <ImportBox kind={tab} onDone={reloadAll} />
        )}
      </div>

      {deployFor && (
        <DeployKeyModal
          pool={deployFor}
          productTitle={prodBy(deployFor.product)?.title ?? deployFor.product}
          onClose={() => setDeployFor(null)}
          onDone={() => pool.reload()}
        />
      )}
      {adding && tab === "users" && (
        <NewUserModal users={users.data ?? []} onClose={() => setAdding(false)} onCreated={() => users.reload()} />
      )}
      {adding && tab !== "users" && tab !== "installs" && (
        <FormModal
          title={forms[tab].title}
          fields={forms[tab].fields}
          onClose={() => setAdding(false)}
          onSubmit={async (v) => {
            await forms[tab].submit(v);
            reloadAll();
          }}
        />
      )}
      {resetFor && (
        <PasswordModal mode="reset" user={resetFor} onClose={() => setResetFor(null)} onDone={() => users.reload()} />
      )}
      {removing && (
        <ConfirmModal
          title={`Удалить ${removing.what}?`}
          confirmLabel="Удалить"
          danger
          onConfirm={async () => {
            await api.del(removing.path);
            reloadAll();
          }}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
