import { Link } from "react-router-dom";
import type { AppUser, Employee } from "../../api/types.ts";
import { dateRu } from "../../format.ts";
import type { PoolKey } from "../DeployKey.tsx";
import { Badge, Dash } from "../ui/index.ts";

// Таблицы вкладок «Настроек»: сотрудники, пользователи, ключи лицензий. rows — текущая страница.

type Remove = (path: string, what: string) => void;

/** Крестик «Удалить» в строке (только администратор; подтверждение — окно на странице). */
function RemoveButton({ path, what, onRemove }: { path: string; what: string; onRemove: Remove }) {
  return (
    <button
      className="icon-x admin-only"
      title="Удалить"
      aria-label={`Удалить ${what}`}
      onClick={() => onRemove(path, what)}
    >
      ×
    </button>
  );
}

export function EmployeesTable({ rows, onRemove }: { rows: Employee[]; onRemove: Remove }) {
  return (
    <>
      <thead>
        <tr>
          <th>ФИО</th>
          <th>Отдел</th>
          <th>ПК</th>
          <th>Статус</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.id}>
            <td className="strong">{e.full_name}</td>
            <td>{e.department ?? <Dash />}</td>
            <td className="mono">
              {e.device_refs?.length ? (
                e.device_refs.map((d) => (
                  <Link className="gap-right" key={d.id} to={`/agents/${d.id}`}>
                    {d.hostname ?? d.serial_number}
                  </Link>
                ))
              ) : (
                <Dash />
              )}
            </td>
            <td>{e.active ? <Badge tone="green">Работает</Badge> : <Badge tone="amber">Уволен</Badge>}</td>
            <td className="right">
              <RemoveButton onRemove={onRemove} path={`/api/employees/${e.id}`} what={`сотрудника «${e.full_name}»`} />
            </td>
          </tr>
        ))}
      </tbody>
    </>
  );
}

export function UsersTable({
  rows,
  onRemove,
  onToggle,
  onReset,
}: {
  rows: AppUser[];
  onRemove: Remove;
  onToggle: (u: AppUser, patch: Partial<AppUser>) => void;
  onReset: (u: AppUser) => void;
}) {
  return (
    <>
      <thead>
        <tr>
          <th>Логин</th>
          <th>Имя</th>
          <th>Роль</th>
          <th>Последний вход</th>
          <th>Статус</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((u) => (
          <tr key={u.id}>
            <td className="mono strong">{u.login}</td>
            <td>{u.name ?? <Dash />}</td>
            <td>
              <select
                className="input sm"
                value={u.role}
                onChange={(e) => onToggle(u, { role: e.target.value as AppUser["role"] })}
              >
                <option value="admin">Администратор</option>
                <option value="viewer">Только просмотр</option>
              </select>
            </td>
            <td className="muted">{u.last_login_at ? dateRu(u.last_login_at) : "не входил"}</td>
            <td>
              <button
                className="link-btn"
                onClick={() => onToggle(u, { active: !u.active })}
                title="Нажмите, чтобы изменить"
              >
                {u.active ? <Badge tone="green">Активен</Badge> : <Badge>Отключён</Badge>}
              </button>
            </td>
            <td className="right nowrap">
              <button className="link-btn" onClick={() => onReset(u)}>
                Сменить пароль
              </button>{" "}
              <RemoveButton onRemove={onRemove} path={`/api/users/${u.id}`} what={`пользователя «${u.login}»`} />
            </td>
          </tr>
        ))}
      </tbody>
    </>
  );
}

export function KeysTable({
  rows,
  onRemove,
  productTitle,
  canDeploy,
  onDeploy,
}: {
  rows: PoolKey[];
  onRemove: Remove;
  productTitle: (product: string) => string;
  canDeploy: (product: string) => boolean;
  onDeploy: (p: PoolKey) => void;
}) {
  return (
    <>
      <thead>
        <tr>
          <th>Продукт</th>
          <th>Название</th>
          <th>Ключ</th>
          <th>Вид</th>
          <th className="num">Мест</th>
          <th className="num">Занято</th>
          <th className="num">Свободно</th>
          <th>До</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.id}>
            <td className="nowrap">{productTitle(p.product)}</td>
            <td className="strong">{p.title}</td>
            <td className="mono muted">{p.key_masked}</td>
            <td className="muted">{p.license_type ?? <Dash />}</td>
            <td className="num">{p.seats}</td>
            <td className="num">{p.used + p.pending}</td>
            <td className={`num ${p.used + p.pending > p.seats ? "red" : "green"}`}>
              {p.used + p.pending > p.seats ? `−${p.used + p.pending - p.seats}` : p.free}
            </td>
            <td>{p.valid_until ? dateRu(p.valid_until) : "бессрочно"}</td>
            <td className="right nowrap">
              {canDeploy(p.product) && (
                <button className="link-btn admin-only" onClick={() => onDeploy(p)}>
                  Раздать…
                </button>
              )}{" "}
              <RemoveButton onRemove={onRemove} path={`/api/license-pool/${p.id}`} what={`ключ «${p.title}»`} />
            </td>
          </tr>
        ))}
      </tbody>
    </>
  );
}
