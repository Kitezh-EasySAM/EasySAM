import { Link } from "react-router-dom";

export const Loading = () => <div className="empty">Загрузка…</div>;
/** Ошибка загрузки. back — ссылка «назад к списку» (карточки); «не найдено» показывается как пустая карточка, а не как сбой. */
export const ErrorBox = ({ text, back }: { text: string; back?: { to: string; label: string } }) => {
  const notFound = /не найден/i.test(text);
  return (
    <div className={`err-box ${notFound ? "nf" : ""}`} role="alert">
      <b>{notFound ? "Не найдено" : "Не удалось загрузить"}</b>
      <span>{notFound ? "Запись удалена или ссылка устарела." : text}</span>
      <span className="err-actions">
        {back && (
          <Link className="btn" to={back.to}>
            ← {back.label}
          </Link>
        )}
        {!notFound && (
          <button className="btn" onClick={() => location.reload()}>
            Повторить
          </button>
        )}
      </span>
    </div>
  );
};
export const Dash = () => <span className="dash">—</span>;
