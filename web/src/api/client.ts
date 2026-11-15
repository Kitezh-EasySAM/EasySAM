export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Сессия — HttpOnly-cookie (ставит POST /api/auth/login), токенов в браузере не храним. 401 → показать вход. */
export const UNAUTHORIZED = "sam:unauthorized";

async function parse<T>(r: Response): Promise<T> {
  if (r.status === 204) return undefined as T;
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && (data as { login?: boolean }).login) window.dispatchEvent(new Event(UNAUTHORIZED));
  if (!r.ok) throw new ApiError((data as { error?: string }).error ?? `Ошибка ${r.status}`, r.status);
  return data as T;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(r);
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
  /** Загрузка файла (multipart, поле file). */
  upload: async <T>(path: string, file: File): Promise<T> => {
    const fd = new FormData();
    fd.append("file", file);
    return parse<T>(await fetch(path, { method: "POST", body: fd, credentials: "same-origin" }));
  },
};

/** Скачать файл с сервера (по сессии). */
export async function download(path: string, name: string) {
  const r = await fetch(path, { credentials: "same-origin" });
  if (!r.ok) {
    await parse(r);
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await r.blob());
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
