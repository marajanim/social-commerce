import { GRAPH_VERSION } from '@sc/channels';

export const META_GRAPH = Symbol('META_GRAPH');

export interface MetaPage {
  id: string;
  name: string;
  /** Page access token. Long-lived when it came from a long-lived user token. */
  accessToken: string;
}

/** Connecting a Page is the one request-time conversation with Meta; nothing else calls it inline. */
export interface MetaGraph {
  /** Who does this Page access token belong to? Null when Facebook rejects the token. */
  getPageIdentity(token: string): Promise<{ id: string; name: string } | null>;
  /** Swaps the one-time `code` from the login redirect for a long-lived user token. Null on failure. */
  exchangeCode(input: { code: string; redirectUri: string; appId: string; appSecret: string }): Promise<string | null>;
  /** Pages the user manages, each with its own access token. */
  listPages(userToken: string): Promise<MetaPage[] | null>;
  /** Subscribes the Page to the app's webhook fields. False when Facebook refuses. */
  subscribePage(pageId: string, pageToken: string): Promise<boolean>;
  unsubscribePage(pageId: string, pageToken: string): Promise<void>;
}

export const SUBSCRIBED_FIELDS = ['messages', 'messaging_postbacks', 'message_echoes', 'message_deliveries', 'message_reads'];
export const OAUTH_SCOPES = ['pages_show_list', 'pages_messaging', 'pages_manage_metadata', 'pages_read_engagement'];

const BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

/**
 * Classic Facebook Login asks for permissions with `scope`. Apps that only offer Facebook Login for
 * Business must send a login configuration id instead (the permissions live in that configuration).
 */
export function buildLoginUrl(input: { appId: string; redirectUri: string; state: string; configId?: string }): string {
  const q = new URLSearchParams({
    client_id: input.appId,
    redirect_uri: input.redirectUri,
    state: input.state,
    response_type: 'code',
  });
  if (input.configId) {
    q.set('config_id', input.configId);
    q.set('override_default_response_type', 'true');
  } else {
    q.set('scope', OAUTH_SCOPES.join(','));
  }
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${q.toString()}`;
}

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T | null> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export class HttpMetaGraph implements MetaGraph {
  async getPageIdentity(token: string): Promise<{ id: string; name: string } | null> {
    const json = await getJson<{ id?: string; name?: string }>(`${BASE}/me?fields=id,name`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return json?.id ? { id: json.id, name: json.name ?? json.id } : null;
  }

  async exchangeCode(input: { code: string; redirectUri: string; appId: string; appSecret: string }): Promise<string | null> {
    // The app secret travels in a POST body, never in a URL that could reach a log.
    const form = (extra: Record<string, string>) =>
      ({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: input.appId, client_secret: input.appSecret, ...extra }).toString(),
      }) satisfies RequestInit;
    const short = await getJson<{ access_token?: string }>(
      `${BASE}/oauth/access_token`,
      form({ code: input.code, redirect_uri: input.redirectUri }),
    );
    if (!short?.access_token) return null;
    // A long-lived user token makes the Page tokens it returns non-expiring.
    const long = await getJson<{ access_token?: string }>(
      `${BASE}/oauth/access_token`,
      form({ grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token }),
    );
    return long?.access_token ?? short.access_token;
  }

  async listPages(userToken: string): Promise<MetaPage[] | null> {
    const json = await getJson<{ data?: { id: string; name: string; access_token?: string }[] }>(
      `${BASE}/me/accounts?fields=id,name,access_token&limit=100`,
      { headers: { authorization: `Bearer ${userToken}` } },
    );
    if (!json?.data) return null;
    return json.data.filter((p) => p.access_token).map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token as string }));
  }

  async subscribePage(pageId: string, pageToken: string): Promise<boolean> {
    const json = await getJson<{ success?: boolean }>(`${BASE}/${pageId}/subscribed_apps`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pageToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ subscribed_fields: SUBSCRIBED_FIELDS.join(',') }).toString(),
    });
    return json?.success === true;
  }

  async unsubscribePage(pageId: string, pageToken: string): Promise<void> {
    await getJson(`${BASE}/${pageId}/subscribed_apps`, { method: 'DELETE', headers: { authorization: `Bearer ${pageToken}` } });
  }
}
