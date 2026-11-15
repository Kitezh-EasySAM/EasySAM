import { useState } from "react";
import { Modal } from "./Modal.tsx";
import { focusOnMount } from "./focus.ts";

/**
 * Подтверждение действия вместо системного confirm(): заголовок-вопрос, кнопки «Отмена» и действие
 * (danger — красная). Escape и «Отмена» закрывают; ошибка onConfirm показывается в окне, окно не закрывается.
 */
export function ConfirmModal({
  title,
  text,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  text?: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      {text && <p className="confirm-text">{text}</p>}
      {err && (
        <div className="uf-err" role="alert">
          {err}
        </div>
      )}
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>
          Отмена
        </button>
        <button
          type="button"
          className={`btn ${danger ? "danger" : "primary"}`}
          disabled={busy}
          ref={focusOnMount}
          onClick={run}
        >
          {busy ? "…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
