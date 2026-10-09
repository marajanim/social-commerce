import { randomUUID } from 'node:crypto';
import { sendMessengerText } from './messenger/send';
import type { ChannelAdapter, ChannelKey, FetchLike, SendRequest, SendResult } from './types';

export * from './types';
export { splitMessengerPayload, messengerEventKey, normalizeMessengerItem, type MessengerItem } from './messenger/parse';
export { verifyMetaSignature, signMetaPayload } from './messenger/signature';
export { sendMessengerText, fetchMessengerProfile, classifyGraphError, GRAPH_VERSION } from './messenger/send';

const messenger: ChannelAdapter = {
  key: 'messenger',
  send: (req: SendRequest, fetchImpl?: FetchLike) => sendMessengerText(req, fetchImpl),
};

/**
 * Website chat: the visitor's browser is the other end, so "sending" means the message is
 * available for the widget to fetch. It always succeeds; delivery happens when the widget polls
 * or its socket reconnects (the widget itself is Phase 2).
 */
const webchat: ChannelAdapter = {
  key: 'webchat',
  async send(): Promise<SendResult> {
    return { ok: true, providerMessageId: `wc_${randomUUID()}` };
  },
};

const ADAPTERS: Partial<Record<ChannelKey, ChannelAdapter>> = { messenger, webchat };

export function getAdapter(key: string): ChannelAdapter | undefined {
  return ADAPTERS[key as ChannelKey];
}
