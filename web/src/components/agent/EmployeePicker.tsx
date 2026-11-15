import { useState } from "react";
import { api } from "../../api/client.ts";
import { useApi } from "../../api/hooks.ts";
import type { Device, Employee } from "../../api/types.ts";
import { AutoInput, Modal, SearchSelect } from "../ui/index.ts";

/** Окно «Сменить / добавить сотрудника» для ПК: выбрать из списка или завести нового и сразу назначить. */
export function EmployeePicker({
  serial,
  current,
  onClose,
  onDone,
}: {
  serial: string;
  current: number | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const emps = useApi<Employee[]>("/api/employees?active=true", false);
  const [id, setId] = useState<string>(current ? String(current) : "");
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"pick" | "add">("pick");
  const [newName, setNewName] = useState("");
  const [newDept, setNewDept] = useState("");
  const depts = [...new Set((emps.data ?? []).map((e) => e.department).filter(Boolean) as string[])].map((d) => ({
    value: d,
    label: d,
  }));
  const [busy, setBusy] = useState(false);
  const save = () =>
    api
      .patch<Device>(`/api/devices/${encodeURIComponent(serial)}`, { employee_id: id ? +id : null })
      .then(onDone, (e) => setErr(e.message));
  const addEmployee = async () => {
    setBusy(true);
    setErr("");
    try {
      const created = await api.post<Employee>("/api/employees", {
        full_name: newName.trim(),
        department: newDept.trim() || null,
      });
      await emps.reload();
      setId(String(created.id));
      setMode("pick");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };
  return (
    <Modal title={mode === "pick" ? "Сменить сотрудника" : "Добавить сотрудника"} onClose={onClose}>
      {mode === "pick" ? (
        <>
          <SearchSelect
            autoFocus
            placeholder=""
            value={id}
            onChange={setId}
            options={(emps.data ?? []).map((e) => ({
              value: String(e.id),
              label: e.full_name,
              hint: e.department ?? undefined,
            }))}
          />
          <div className="mt">
            <button
              className="btn"
              onClick={() => {
                setMode("add");
                setErr("");
              }}
            >
              ＋ Добавить сотрудника
            </button>
          </div>
        </>
      ) : (
        <div className="stack">
          <input
            className="input w-full"
            placeholder="ФИО"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && newName.trim() && addEmployee()}
          />
          <AutoInput placeholder="Отдел" value={newDept} onChange={setNewDept} options={depts} />
          <button className="btn primary" disabled={!newName.trim() || busy} onClick={addEmployee}>
            {busy ? "Сохранение…" : "Добавить"}
          </button>
        </div>
      )}
      {err && <div className="err below">{err}</div>}
      <div className="actions">
        {mode === "add" && (
          <button
            className="btn"
            onClick={() => {
              setMode("pick");
              setErr("");
            }}
          >
            Назад
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Отмена
        </button>
        <button className="btn primary" onClick={save} disabled={mode === "add"}>
          Сохранить
        </button>
      </div>
    </Modal>
  );
}
