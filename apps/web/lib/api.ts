// Browser-side calls go to the same origin (/api/*), which Next rewrites to the API, so the
// HttpOnly session cookie is first-party.
export interface ApiResult<T> {
  status: number;
  ok: boolean;
  data: T | null;
}

export async function apiRequest<T = unknown>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const text = await res.text();
    let data: T | null = null;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        data = null;
      }
    }
    return { status: res.status, ok: res.ok, data };
  } catch {
    return { status: 0, ok: false, data: null };
  }
}

export const apiGet = <T>(path: string) => apiRequest<T>('GET', path);
export const apiPostJson = <T>(path: string, body: unknown = {}, headers?: Record<string, string>) =>
  apiRequest<T>('POST', path, body, headers);
export const apiDelete = (path: string) => apiRequest('DELETE', path);

/** Kept for the auth pages. */
export async function apiPost(path: string, body: unknown = {}): Promise<{ status: number; ok: boolean }> {
  const r = await apiRequest('POST', path, body);
  return { status: r.status, ok: r.ok };
}
