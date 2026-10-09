import { describe, expect, it } from 'vitest';
import { evaluateSend, type EligibilityInput } from './eligibility';

const HOUR = 3_600_000;
const now = new Date('2026-10-10T12:00:00Z');
const ago = (h: number) => new Date(now.getTime() - h * HOUR);

const base: EligibilityInput = {
  channelStatus: 'connected',
  standardWindowHours: 24,
  humanAgentWindowHours: 168,
  lastInboundAt: ago(1),
  now,
  sender: 'user',
};

describe('evaluateSend (Messenger rules)', () => {
  it.each([
    ['inside 24h, human', { lastInboundAt: ago(23.9) }, { allowed: true, messageTag: null }],
    ['inside 24h, AI', { lastInboundAt: ago(2), sender: 'ai' as const }, { allowed: true, messageTag: null }],
    ['24h to 7d, human gets the HUMAN_AGENT tag', { lastInboundAt: ago(48) }, { allowed: true, messageTag: 'HUMAN_AGENT' }],
    ['exactly 24h is already outside', { lastInboundAt: ago(24) }, { allowed: true, messageTag: 'HUMAN_AGENT' }],
    ['24h to 7d, AI is blocked', { lastInboundAt: ago(48), sender: 'ai' as const }, { allowed: false, reason: 'ai_outside_window' }],
    ['after 7d, blocked', { lastInboundAt: ago(24 * 8) }, { allowed: false, reason: 'window_closed' }],
    ['exactly 7d is closed', { lastInboundAt: ago(168) }, { allowed: false, reason: 'window_closed' }],
    ['customer never wrote', { lastInboundAt: null }, { allowed: false, reason: 'no_inbound' }],
    ['disconnected channel', { channelStatus: 'disconnected' as const }, { allowed: false, reason: 'channel_unavailable' }],
    ['channel needs attention', { channelStatus: 'needs_attention' as const }, { allowed: false, reason: 'channel_unavailable' }],
  ])('%s', (_name, patch, expected) => {
    expect(evaluateSend({ ...base, ...patch })).toMatchObject(expected);
  });

  it('reports when the standard window ends', () => {
    const r = evaluateSend({ ...base, lastInboundAt: ago(4) });
    expect(r.windowExpiresAt?.getTime()).toBe(ago(4).getTime() + 24 * HOUR);
  });

  it('has no window on website chat, even with no inbound yet', () => {
    const r = evaluateSend({ ...base, standardWindowHours: null, humanAgentWindowHours: null, lastInboundAt: null });
    expect(r).toEqual({ allowed: true, messageTag: null, windowExpiresAt: null });
  });

  it('never allows a disconnected website chat channel', () => {
    expect(evaluateSend({ ...base, standardWindowHours: null, channelStatus: 'disconnected' }).allowed).toBe(false);
  });

  it('a channel without a HUMAN_AGENT window (WhatsApp) closes after the standard window', () => {
    const r = evaluateSend({ ...base, humanAgentWindowHours: null, lastInboundAt: ago(30) });
    expect(r).toMatchObject({ allowed: false, reason: 'window_closed' });
  });
});
