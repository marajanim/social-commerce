// Browser-side calls go to the same origin (/api/*), which Next rewrites to the API, so the
// HttpOnly session cookie is first-party.
export async function apiPost(path: string, body: unknown = {}): Promise<{ status: number; ok: boolean }> {
  try {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
    });
    return { status: res.status, ok: res.ok };
  } catch {
    return { status: 0, ok: false };
  }
}
