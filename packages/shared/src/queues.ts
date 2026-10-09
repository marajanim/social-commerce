import { z } from 'zod';

// BullMQ queue names and job payload schemas. Producers (api) and consumers (worker) both
// validate against these, so a malformed job fails at the edge.
export const QUEUES = { email: 'email' } as const;

export const emailJob = z.object({
  to: z.string().email(),
  template: z.enum(['password-reset', 'verify-email']),
  /** Absolute link the user clicks. Never log it: it carries a token. */
  link: z.string().url(),
  locale: z.enum(['en', 'bn']).default('en'),
});
export type EmailJob = z.infer<typeof emailJob>;

// Inbox queues. Jobs carry IDs only; workers load the data under the right tenant.
export const INBOX_QUEUES = { inbound: 'inbound', outbound: 'outbound' } as const;

/** A stored webhook event to process. The tenant is not known yet: the worker resolves it. */
export const inboundJob = z.object({ webhookEventId: z.string().uuid() });
export type InboundJob = z.infer<typeof inboundJob>;

/** A pending outbound message to deliver. tenantId comes from trusted server code. */
export const outboundJob = z.object({ tenantId: z.string().uuid(), messageId: z.string().uuid() });
export type OutboundJob = z.infer<typeof outboundJob>;
