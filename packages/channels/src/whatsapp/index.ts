import { createHash } from 'node:crypto';
import { classifyGraphError, GRAPH_VERSION } from '../messenger/send';
import type { FetchLike, NormalizedEvent, SendRequest, SendResult } from '../types';

interface Message {
  id?: string; from?: string; timestamp?: string; type?: string;
  text?: { body?: string };
  image?: { id?: string; caption?: string }; video?: { id?: string; caption?: string };
  audio?: { id?: string }; document?: { id?: string; caption?: string; filename?: string };
  sticker?: { id?: string }; location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  button?: { text?: string; payload?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}
interface Status { id?: string; recipient_id?: string; timestamp?: string; status?: string }
export interface WhatsAppItem {
  phoneNumberId: string;
  message?: Message;
  status?: Status;
  profile?: { name: string | null; picUrl: null };
}

/** Cloud API batches multiple WABAs, numbers, messages and receipts in a signed envelope. */
export function splitWhatsAppPayload(payload: unknown): WhatsAppItem[] {
  const p = payload as { object?: string; entry?: { changes?: { field?: string; value?: {
    metadata?: { phone_number_id?: string };
    contacts?: { wa_id?: string; profile?: { name?: string } }[];
    messages?: Message[]; statuses?: Status[];
  } }[] }[] } | null;
  if (p?.object !== 'whatsapp_business_account' || !Array.isArray(p.entry)) return [];
  const out: WhatsAppItem[] = [];
  for (const entry of p.entry) for (const change of entry.changes ?? []) {
    const v = change.value;
    if (change.field !== 'messages' || !v?.metadata?.phone_number_id) continue;
    for (const message of v.messages ?? []) {
      const name = v.contacts?.find(c => c.wa_id === message.from)?.profile?.name?.trim() || null;
      out.push({ phoneNumberId: v.metadata.phone_number_id, message, profile: { name, picUrl: null } });
    }
    for (const status of v.statuses ?? []) out.push({ phoneNumberId: v.metadata.phone_number_id, status });
  }
  return out;
}

export function whatsAppEventKey(item: WhatsAppItem): string {
  const event = item.message ? ['message', item.message.id] : ['status', item.status?.id, item.status?.status, item.status?.timestamp];
  return `wa:${createHash('sha256').update(JSON.stringify([item.phoneNumberId, ...event])).digest('hex')}`;
}

export function normalizeWhatsAppItem(item: WhatsAppItem): NormalizedEvent {
  const unsupported = { kind: 'unsupported' as const, externalAccountId: item.phoneNumberId, reason: 'unsupported WhatsApp event' };
  const m = item.message;
  const s = item.status;
  const timestamp = new Date(Number(m?.timestamp ?? s?.timestamp) * 1000);
  if (!item.phoneNumberId || !Number.isFinite(timestamp.getTime())) return unsupported;
  if (s?.id && s.recipient_id && (s.status === 'delivered' || s.status === 'read')) return {
    kind: 'status', externalAccountId: item.phoneNumberId, externalUserId: s.recipient_id,
    status: s.status, watermark: timestamp, providerMessageIds: [s.id],
  };
  if (!m?.id || !m.from) return unsupported;
  const mediaType = m.type === 'document' ? 'file' : m.type;
  const contentType = ['image', 'video', 'audio', 'file', 'sticker', 'location'].includes(mediaType ?? '')
    ? mediaType as 'image' | 'video' | 'audio' | 'file' | 'sticker' | 'location'
    : ['text', 'button', 'interactive'].includes(m.type ?? '') ? 'text' : 'unsupported';
  const body = m.text?.body ?? m.image?.caption ?? m.video?.caption ?? m.document?.caption
    ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
  return {
    kind: 'message', externalAccountId: item.phoneNumberId, externalUserId: m.from,
    providerMessageId: m.id, timestamp, contentType, body,
    attachments: contentType !== 'text' && contentType !== 'unsupported' ? [{ type: contentType }] : [],
    isEcho: false, extra: { whatsapp: m },
  };
}

export async function sendWhatsAppText(req: SendRequest, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<SendResult> {
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${GRAPH_VERSION}/${req.externalAccountId}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${req.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: req.recipientId, type: 'text', text: { body: req.body } }),
    });
    const json = await res.json() as { messages?: { id?: string }[]; error?: { code?: number; message?: string } };
    const mid = json.messages?.[0]?.id;
    if (res.ok && mid) return { ok: true, providerMessageId: mid };
    const failure = classifyGraphError(res.status, json);
    if ([131047, 131026, 131030].includes(json.error?.code ?? 0)) failure.kind = 'user_fixable';
    if ([130429, 131048, 131056].includes(json.error?.code ?? 0)) failure.kind = 'retryable';
    return { ok: false, ...failure };
  } catch {
    return { ok: false, kind: 'retryable', code: 'network', reason: 'Could not reach WhatsApp' };
  }
}
