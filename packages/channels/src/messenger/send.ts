import type { FetchLike, SendFailureKind, SendRequest, SendResult } from '../types';

export const GRAPH_VERSION = 'v21.0';

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

// Graph API error codes, grouped by what the caller should do. Source: Meta Send API reference.
const AUTH = new Set([190, 102, 463, 467]); // token invalid / expired / revoked
const RETRYABLE = new Set([1, 2, 4, 17, 32, 341, 613]); // temporary, rate limits
const USER_FIXABLE = new Set([10, 200, 230, 299, 551]); // permission, user not available
const WINDOW_SUBCODES = new Set([2018278]); // outside the allowed window

export function classifyGraphError(status: number, body: GraphError): { kind: SendFailureKind; code: string; reason: string } {
  const err = body.error;
  const code = err?.code;
  const sub = err?.error_subcode;
  const reason = err?.message ?? `HTTP ${status}`;
  const label = `${code ?? status}${sub ? `/${sub}` : ''}`;
  if (code !== undefined && AUTH.has(code)) return { kind: 'auth', code: label, reason };
  if (sub !== undefined && WINDOW_SUBCODES.has(sub)) return { kind: 'user_fixable', code: label, reason };
  if (code !== undefined && USER_FIXABLE.has(code)) return { kind: 'user_fixable', code: label, reason };
  if (status >= 500 || status === 429 || (code !== undefined && RETRYABLE.has(code))) {
    return { kind: 'retryable', code: label, reason };
  }
  return { kind: 'permanent', code: label, reason };
}

/**
 * Sends a text message through the Send API. The token goes in the Authorization header, never
 * in the URL, so it cannot end up in access logs. Never throws: failures are classified.
 */
export async function sendMessengerText(
  req: SendRequest,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SendResult> {
  const body = {
    recipient: { id: req.recipientId },
    ...(req.messageTag
      ? { messaging_type: 'MESSAGE_TAG', tag: req.messageTag }
      : { messaging_type: 'RESPONSE' }),
    message: { text: req.body },
  };
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${req.externalAccountId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${req.token}` },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as GraphError & { message_id?: string };
    if (res.ok && json.message_id) return { ok: true, providerMessageId: json.message_id };
    return { ok: false, ...classifyGraphError(res.status, json) };
  } catch (err) {
    return { ok: false, kind: 'retryable', code: 'network', reason: err instanceof Error ? err.message : 'network error' };
  }
}

/** Best-effort customer name and photo for a new contact. Null on any failure. */
export async function fetchMessengerProfile(
  token: string,
  psid: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ name: string | null; picUrl: string | null } | null> {
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${psid}?fields=name,profile_pic`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { name?: string; profile_pic?: string };
    return { name: json.name ?? null, picUrl: json.profile_pic ?? null };
  } catch {
    return null;
  }
}
