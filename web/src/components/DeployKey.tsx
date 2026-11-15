import { useState } from "react";
import { api } from "../api/client.ts";
import { useApi } from "../api/hooks.ts";
import { Modal } from "./ui/index.ts";

export interface PoolKey {
  id: number;
  product: string;
  title: string;
  key_masked: string;
  seats: number;
  used: number;
  pending: number;
  free: number;
  valid_until: string | null;
  license_type: string | null;
}
export interface PoolProduct {
  product: string;
  title: string;
  can_deploy: boolean;
  key_hint: string;
  key_placeholder: string;
}
interface Overview {
  application: string;
  trial: number;
  expired: number;
  expiring: number;
  unlicensed: number;
  devices: number;
}

type Filter = "without" | "trial" | "expiring" | "expired" | "unlicensed";
const FILTERS: { id: Filter; label: string; hint: string; count?: (o: Overview) => number }[] = [
  { id: "without", label: "Где продукт стоит без лицензии", hint: "установлен, а лицензии с ПК нет" },
  { id: "trial", label: "На пробной лицензии", hint: "пробная / временная", count: (o) => o.trial },
  { id: "expiring", label: "Лицензия скоро истекает", hint: "меньше 30 дней", count: (o) => o.expiring },
  { id: "expired", label: "Лицензия истекла", hint: "", count: (o) => o.expired },
  { id: "unlicensed", label: "Не активировано", hint: "", count: (o) => o.unlicensed },
];

/** Раздать ключ из хранилища на ПК (POST /api/license-pool/:id/deploy, API §12): агент поставит его и отчитается в ленту. */
export function DeployKeyModal({
  pool,
  productTitle,
  onClose,
  onDone,
}: {
  pool: PoolKey;
  productTitle: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const over = useApi<Overview[]>("/api/license-products", false);
  const o = over.data?.find((x) => x.application === pool.product);
  const [filter, setFilter] = useState<Filter>("without");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [res, setRes] = useState<{ queued: number; skipped_already: number } | null>(null);

  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      setRes(await api.post(`/api/license-pool/${pool.id}/deploy`, { filter }));
      onDone();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Раздать ключ: ${pool.title}`} onClose={onClose}>
      <p className="muted dk-lead">
        {productTitle} · ключ {pool.key_masked} · свободно <b className="green">{pool.free}</b> из {pool.seats}
        {pool.pending ? ` (ещё ${pool.pending} в пути)` : ""}
      </p>
      {!res ? (
        <>
          <fieldset className="dk-opts">
            <legend>На какие ПК</legend>
            {FILTERS.map((f) => {
              const n = o && f.count ? f.count(o) : null;
              return (
                <label key={f.id} className={`dk-opt ${filter === f.id ? "on" : ""}`}>
                  <input type="radio" name="dk" checked={filter === f.id} onChange={() => setFilter(f.id)} />
                  <span>
                    <b>{f.label}</b>
                  </span>
                  {n != null && <span className={`dk-n ${n ? "" : "muted"}`}>{n} ПК</span>}
                </label>
              );
            })}
          </fieldset>
          {err && (
            <div className="err" role="alert">
              {err}
            </div>
          )}
          <div className="actions">
            <button className="btn" onClick={onClose}>
              Отмена
            </button>
            <button className="btn primary" disabled={busy || pool.free === 0} onClick={run}>
              {busy ? "Ставлю в очередь…" : "Раздать"}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="ca-done">
            <b>{res.queued ? `Задание отправлено на ${res.queued} ПК` : "Раздавать некому"}</b>
            <span className="muted">
              {res.skipped_already ? `${res.skipped_already} ПК пропущено — ключ уже стоит или задание в пути. ` : ""}
              {res.queued ? "Результат — в колокольчике и «Ленте событий»." : "Под выбранное условие ПК не нашлось."}
            </span>
          </div>
          <div className="actions">
            <button className="btn primary" onClick={onClose}>
              Готово
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
