import type { StreamAlert } from "./types.ts";

type Handler = (data: unknown) => void;
const handlers = new Map<string, Set<Handler>>();
let es: EventSource | null = null;
const TYPES = ["install", "ingest", "license", "process", "command", "changed", "agent"];

/** Один общий EventSource на вкладку (после входа). */
export function connectStream() {
  if (es) return;
  es = new EventSource("/api/stream", { withCredentials: true }); // сессия — cookie, токена в адресе нет
  for (const t of TYPES) {
    es.addEventListener(t, (e) => {
      let data: unknown = null;
      try {
        data = JSON.parse((e as MessageEvent).data);
      } catch {
        /* пустое сообщение */
      }
      handlers.get(t)?.forEach((h) => h(data));
    });
  }
}

/** Подписка на сообщения одного типа; T — форма данных этого типа (сервер — docs/API.md §8). Возвращает отписку. */
export function onStream<T = unknown>(type: string, h: (data: T) => void) {
  const handler = h as Handler; // данные приходят из JSON.parse — форму задаёт контракт API, а не проверка
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type)!.add(handler);
  return () => {
    handlers.get(type)!.delete(handler);
  };
}

/** Сообщение ленты, у которого может быть тревога (install, license, process) или итог задания (command). */
interface AlertMessage {
  ok?: boolean;
  text?: string;
  alert?: StreamAlert | null;
}

export function alertOf(type: string, data: unknown): { level: "red" | "yellow" | "green"; text: string } | null {
  const m = (data ?? {}) as AlertMessage;
  if (type === "command") return { level: m.ok ? "green" : "red", text: m.text ?? "" };
  const a = m.alert;
  return a ? { level: a.level, text: a.text } : null;
}

/** Выход: закрыть поток (иначе он продолжит переподключаться без сессии). */
export function disconnectStream() {
  es?.close();
  es = null;
}
