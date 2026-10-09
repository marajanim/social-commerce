import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { messengerEventKey, normalizeMessengerItem, splitMessengerPayload } from './parse';
import { classifyGraphError, sendMessengerText } from './send';
import { signMetaPayload, verifyMetaSignature } from './signature';
import type { FetchLike } from '../types';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(__dirname, 'fixtures', `${name}.json`), 'utf8'));
const normalizeOne = (name: string) => {
  const items = splitMessengerPayload(fixture(name));
  expect(items).toHaveLength(1);
  return normalizeMessengerItem(items[0] as (typeof items)[number]);
};

describe('normalize (recorded payloads)', () => {
  it('text', () => {
    expect(normalizeOne('text')).toMatchObject({
      kind: 'message',
      externalAccountId: '1001',
      externalUserId: '2002',
      providerMessageId: 'm_text_1',
      contentType: 'text',
      body: 'দাম কত?',
      isEcho: false,
    });
  });

  it('image', () => {
    expect(normalizeOne('image')).toMatchObject({
      kind: 'message',
      contentType: 'image',
      body: null,
      attachments: [{ type: 'image', url: 'https://scontent.example/photo.jpg' }],
    });
  });

  it('sticker', () => {
    expect(normalizeOne('sticker')).toMatchObject({ kind: 'message', contentType: 'sticker' });
  });

  it('postback becomes a text message with its payload kept', () => {
    expect(normalizeOne('postback')).toMatchObject({
      kind: 'message',
      providerMessageId: 'm_pb_1',
      body: 'Order now',
      extra: { postbackPayload: 'ORDER_NOW' },
    });
  });

  it('echo: the customer is the recipient, and the sending app is kept', () => {
    expect(normalizeOne('echo-business-suite')).toMatchObject({
      kind: 'message',
      isEcho: true,
      externalUserId: '2002',
      echoAppId: '263902037430900',
      body: 'জি, স্টকে আছে',
    });
    expect(normalizeOne('echo-own-app')).toMatchObject({ isEcho: true, echoAppId: '777000' });
  });

  it('delivery and read are watermarks', () => {
    expect(normalizeOne('delivery')).toMatchObject({
      kind: 'status',
      status: 'delivered',
      providerMessageIds: ['m_echo_ours'],
      watermark: new Date(1790000005500),
    });
    expect(normalizeOne('read')).toMatchObject({ kind: 'status', status: 'read', watermark: new Date(1790000006500) });
  });

  it('unknown event types become unsupported without throwing', () => {
    expect(normalizeOne('unknown')).toMatchObject({ kind: 'unsupported', externalAccountId: '1001' });
    expect(normalizeMessengerItem({ pageId: '1', item: {} })).toMatchObject({ kind: 'unsupported' });
  });

  it('ignores payloads that are not Page events', () => {
    expect(splitMessengerPayload({ object: 'instagram', entry: [] })).toEqual([]);
    expect(splitMessengerPayload(null)).toEqual([]);
  });
});

describe('splitting and event keys', () => {
  it('splits a batch into one item per message, per Page', () => {
    const items = splitMessengerPayload(fixture('batch'));
    expect(items.map((i) => [i.pageId, i.item.message?.mid])).toEqual([
      ['1001', 'm_b1'],
      ['1001', 'm_b2'],
      ['1002', 'm_b3'],
    ]);
  });

  it('gives the same key to a redelivered event and different keys to different events', () => {
    const a = splitMessengerPayload(fixture('text'))[0];
    const b = splitMessengerPayload(fixture('text'))[0];
    const c = splitMessengerPayload(fixture('image'))[0];
    if (!a || !b || !c) throw new Error('fixture missing');
    expect(messengerEventKey(a)).toBe(messengerEventKey(b));
    expect(messengerEventKey(a)).not.toBe(messengerEventKey(c));
    const d = splitMessengerPayload(fixture('delivery'))[0];
    const r = splitMessengerPayload(fixture('read'))[0];
    if (!d || !r) throw new Error('fixture missing');
    expect(messengerEventKey(d)).not.toBe(messengerEventKey(r));
  });
});

describe('signature', () => {
  const secret = 'app-secret';
  const body = Buffer.from(JSON.stringify(fixture('text')));

  it('accepts a correct signature over the raw body', () => {
    expect(verifyMetaSignature(body, signMetaPayload(body, secret), secret)).toBe(true);
  });

  it('rejects wrong secrets, tampered bodies and malformed headers', () => {
    expect(verifyMetaSignature(body, signMetaPayload(body, 'other'), secret)).toBe(false);
    expect(verifyMetaSignature(Buffer.from('{"tampered":1}'), signMetaPayload(body, secret), secret)).toBe(false);
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=zz', secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', secret)).toBe(false);
  });
});

describe('send', () => {
  const req = { token: 'PAGE_TOKEN', externalAccountId: '1001', recipientId: '2002', body: 'hello' };
  const respond = (status: number, json: unknown): FetchLike => async () => ({ ok: status < 400, status, json: async () => json });

  it('posts to the Send API with the token in a header, not the URL', async () => {
    let seen: { url: string; headers: Record<string, string>; body: unknown } | undefined;
    const fake: FetchLike = async (url, init) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body ?? '{}') };
      return { ok: true, status: 200, json: async () => ({ recipient_id: '2002', message_id: 'm_sent_1' }) };
    };
    expect(await sendMessengerText(req, fake)).toEqual({ ok: true, providerMessageId: 'm_sent_1' });
    expect(seen?.url).toMatch(/graph\.facebook\.com\/v[\d.]+\/1001\/messages$/);
    expect(seen?.url).not.toContain('PAGE_TOKEN');
    expect(seen?.headers.authorization).toBe('Bearer PAGE_TOKEN');
    expect(seen?.body).toEqual({ recipient: { id: '2002' }, messaging_type: 'RESPONSE', message: { text: 'hello' } });
  });

  it('uses the HUMAN_AGENT tag when asked', async () => {
    let body: unknown;
    const fake: FetchLike = async (_u, init) => {
      body = JSON.parse(init.body ?? '{}');
      return { ok: true, status: 200, json: async () => ({ message_id: 'm2' }) };
    };
    await sendMessengerText({ ...req, messageTag: 'HUMAN_AGENT' }, fake);
    expect(body).toMatchObject({ messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' });
  });

  it.each([
    [400, { error: { code: 190, message: 'Invalid OAuth access token' } }, 'auth'],
    [400, { error: { code: 10, error_subcode: 2018278, message: 'outside window' } }, 'user_fixable'],
    [400, { error: { code: 551, message: 'user unavailable' } }, 'user_fixable'],
    [400, { error: { code: 4, message: 'rate limit' } }, 'retryable'],
    [503, {}, 'retryable'],
    [400, { error: { code: 100, message: 'Invalid parameter' } }, 'permanent'],
  ] as const)('classifies %s %j as %s', async (status, json, kind) => {
    const r = await sendMessengerText(req, respond(status, json));
    expect(r).toMatchObject({ ok: false, kind });
  });

  it('classifies a network failure as retryable and never throws', async () => {
    const r = await sendMessengerText(req, async () => {
      throw new Error('ECONNRESET');
    });
    expect(r).toMatchObject({ ok: false, kind: 'retryable', code: 'network' });
  });

  it('classifyGraphError keeps the code for support', () => {
    expect(classifyGraphError(400, { error: { code: 10, error_subcode: 2018278 } }).code).toBe('10/2018278');
  });
});
