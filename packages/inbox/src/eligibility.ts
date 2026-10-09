// The one place that decides whether a message may be sent right now (Feature Specs, Module 2).
// Pure and table-testable: callers load the facts and pass them in.

export type SenderKind = 'user' | 'ai';

export interface EligibilityInput {
  channelStatus: 'connecting' | 'connected' | 'needs_attention' | 'disconnected';
  /** From the channels catalog. null = this channel has no messaging window (website chat). */
  standardWindowHours: number | null;
  humanAgentWindowHours: number | null;
  lastInboundAt: Date | null;
  now: Date;
  sender: SenderKind;
}

export type BlockReason =
  | 'channel_unavailable' // disconnected or token needs attention
  | 'no_inbound' // the customer has never written, so there is nothing to reply to
  | 'window_closed' // beyond every allowed window
  | 'ai_outside_window'; // the AI never sends outside the standard window

export type Eligibility =
  | { allowed: true; messageTag: 'HUMAN_AGENT' | null; windowExpiresAt: Date | null }
  | { allowed: false; reason: BlockReason; windowExpiresAt: Date | null };

const HOUR = 60 * 60 * 1000;

export function evaluateSend(i: EligibilityInput): Eligibility {
  const windowEnd = (hours: number) => (i.lastInboundAt ? new Date(i.lastInboundAt.getTime() + hours * HOUR) : null);
  const standardEnd = i.standardWindowHours === null ? null : windowEnd(i.standardWindowHours);

  if (i.channelStatus === 'disconnected' || i.channelStatus === 'needs_attention' || i.channelStatus === 'connecting') {
    return { allowed: false, reason: 'channel_unavailable', windowExpiresAt: standardEnd };
  }
  if (i.standardWindowHours === null) return { allowed: true, messageTag: null, windowExpiresAt: null };

  if (!i.lastInboundAt) return { allowed: false, reason: 'no_inbound', windowExpiresAt: null };

  if (standardEnd && i.now < standardEnd) return { allowed: true, messageTag: null, windowExpiresAt: standardEnd };

  if (i.sender === 'ai') return { allowed: false, reason: 'ai_outside_window', windowExpiresAt: standardEnd };

  const humanEnd = i.humanAgentWindowHours === null ? null : windowEnd(i.humanAgentWindowHours);
  if (humanEnd && i.now < humanEnd) return { allowed: true, messageTag: 'HUMAN_AGENT', windowExpiresAt: standardEnd };

  return { allowed: false, reason: 'window_closed', windowExpiresAt: standardEnd };
}
