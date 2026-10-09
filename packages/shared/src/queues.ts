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
