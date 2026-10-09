import { describe, expect, it } from 'vitest';
import { normalizeWhatsAppItem, sendWhatsAppText, splitWhatsAppPayload, whatsAppEventKey } from './index';

describe('WhatsApp Cloud API', () => {
  const envelope = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '12345' }, contacts: [{ wa_id: '8801700000000', profile: { name: 'Karim' } }],
    messages: [{ from: '8801700000000', id: 'wamid.1', timestamp: '1700000000', type: 'text', text: { body: 'hello' } }],
    statuses: [{ recipient_id: '8801700000000', id: 'wamid.2', timestamp: '1700000001', status: 'read' }],
  } }] }] };
  it('splits messages and receipts and keeps the correct contact profile', () => {
    const items = splitWhatsAppPayload(envelope);
    expect(items).toHaveLength(2);
    expect(items[0]?.profile?.name).toBe('Karim');
    expect(normalizeWhatsAppItem(items[0]!)).toMatchObject({ kind: 'message', body: 'hello', externalAccountId: '12345', externalUserId: '8801700000000' });
    expect(normalizeWhatsAppItem(items[1]!)).toMatchObject({ kind: 'status', status: 'read', providerMessageIds: ['wamid.2'] });
    expect(whatsAppEventKey(items[0]!)).not.toBe(whatsAppEventKey(items[1]!));
    expect(whatsAppEventKey(items[0]!)).toBe(whatsAppEventKey(splitWhatsAppPayload(envelope)[0]!));
  });
  it('rejects unrelated envelopes and invalid timestamps', () => {
    expect(splitWhatsAppPayload(null)).toEqual([]);
    expect(splitWhatsAppPayload({ object: 'page', entry: [] })).toEqual([]);
    expect(normalizeWhatsAppItem({ phoneNumberId: '12345', message: { id: 'x', from: 'y', timestamp: 'invalid' } }).kind).toBe('unsupported');
  });
  it('retains media captions and IDs without exposing an unauthenticated URL', () => {
    expect(normalizeWhatsAppItem({ phoneNumberId: '12345', message: { id: 'x', from: 'y', timestamp: '1700000000', type: 'image', image: { id: 'media-id', caption: 'Photo' } } })).toMatchObject({ contentType: 'image', body: 'Photo', attachments: [{ type: 'image' }], extra: { whatsapp: { image: { id: 'media-id' } } } });
  });
  it('sends through WhatsApp with credentials in the header', async () => {
    const result = await sendWhatsAppText({ token: 'secret', externalAccountId: '12345', recipientId: '88017', body: 'reply' }, async (url, init) => {
      expect(url).not.toContain('secret'); expect(init.headers.authorization).toBe('Bearer secret');
      expect(JSON.parse(init.body!)).toEqual({ messaging_product: 'whatsapp', to: '88017', type: 'text', text: { body: 'reply' } });
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.reply' }] }) };
    });
    expect(result).toEqual({ ok: true, providerMessageId: 'wamid.reply' });
  });
  it.each([[131047, 'user_fixable'], [130429, 'retryable'], [190, 'auth']])('classifies error %s', async (code, kind) => {
    const r = await sendWhatsAppText({ token: 't', externalAccountId: '1', recipientId: '2', body: 'hi' }, async () => ({ ok: false, status: 400, json: async () => ({ error: { code } }) }));
    expect(r).toMatchObject({ ok: false, kind });
  });
});
