import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpMetaGraph } from './meta-graph';

type Reply = { status: number; body: unknown };

/** Stubs global fetch with one reply per Graph path, and records the paths that were called. */
function stubGraph(replies: Record<string, Reply>) {
  const called: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/v[\d.]+/, '') + new URL(url).search;
    called.push(path);
    const r = replies[path] ?? { status: 404, body: { error: { message: 'unexpected call', code: 803 } } };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  });
  return called;
}

const PERMISSION_ERROR = {
  error: {
    message: "(#100) Object does not exist, cannot be loaded due to missing permission or reviewable feature, or does not support this operation. This endpoint requires the 'pages_read_engagement' permission",
    code: 100,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('HttpMetaGraph.getPageIdentity', () => {
  it('uses the name when the token may read it', async () => {
    stubGraph({ '/me?fields=id,name': { status: 200, body: { id: '123456789', name: 'My Shop' } } });
    expect(await new HttpMetaGraph().getPageIdentity('T', '123456789')).toEqual({ ok: true, id: '123456789', name: 'My Shop' });
  });

  it('accepts a Messenger token without pages_read_engagement when it can manage the Page', async () => {
    const called = stubGraph({
      '/me?fields=id,name': { status: 400, body: PERMISSION_ERROR },
      '/123456789/subscribed_apps': { status: 200, body: { data: [] } },
    });
    expect(await new HttpMetaGraph().getPageIdentity('T', '123456789')).toEqual({ ok: true, id: '123456789', name: null });
    expect(called).toEqual(['/me?fields=id,name', '/123456789/subscribed_apps']);
  });

  it('rejects a token that cannot manage the Page, with Facebook’s reason', async () => {
    stubGraph({
      '/me?fields=id,name': { status: 400, body: PERMISSION_ERROR },
      '/123456789/subscribed_apps': { status: 403, body: { error: { message: '(#200) Permissions error', code: 200 } } },
    });
    expect(await new HttpMetaGraph().getPageIdentity('T', '123456789')).toEqual({ ok: false, reason: '(#200) Permissions error' });
  });

  it('stops at an invalid or expired token', async () => {
    const called = stubGraph({
      '/me?fields=id,name': { status: 400, body: { error: { message: 'Session has expired', code: 190 } } },
    });
    expect(await new HttpMetaGraph().getPageIdentity('T', '123456789')).toEqual({ ok: false, reason: 'Session has expired' });
    expect(called).toHaveLength(1);
  });

  it('sends the token in a header, never in the URL', async () => {
    const seen: { url: string; auth?: string }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, auth: init.headers.authorization });
      return { ok: true, status: 200, json: async () => ({ id: '1', name: 'x' }) };
    });
    await new HttpMetaGraph().getPageIdentity('SECRET_TOKEN', '1');
    expect(seen[0]?.url).not.toContain('SECRET_TOKEN');
    expect(seen[0]?.auth).toBe('Bearer SECRET_TOKEN');
  });
});
