import { GRAPH_VERSION } from '@sc/channels';

export const META_GRAPH = Symbol('META_GRAPH');

export interface MetaGraph {
  /** Who does this Page access token belong to? Null when Facebook rejects the token. */
  getPageIdentity(token: string): Promise<{ id: string; name: string } | null>;
}

/** Connecting a Page is the one request-time call to Meta, and only to prove the token is real. */
export class HttpMetaGraph implements MetaGraph {
  async getPageIdentity(token: string): Promise<{ id: string; name: string } | null> {
    try {
      const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me?fields=id,name`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { id?: string; name?: string };
      return json.id ? { id: json.id, name: json.name ?? json.id } : null;
    } catch {
      return null;
    }
  }
}
