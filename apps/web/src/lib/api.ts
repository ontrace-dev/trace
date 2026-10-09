export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  const h = new Headers(headers);
  if (json !== undefined) h.set("content-type", "application/json");
  const res = await fetch(`/api${path}`, {
    credentials: "include",
    ...rest,
    headers: h,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText, data);
  return data as T;
}

/** Workspace-scoped API helper. */
export const wapi = <T = unknown>(wid: string, path: string, init?: RequestInit & { json?: unknown }) =>
  api<T>(`/w/${wid}${path}`, init);
