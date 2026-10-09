import { emailJob } from '@sc/shared';
import { renderEmail } from './templates';

export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

/**
 * Sends one queued email. The payload is validated again here because a queue is an input
 * boundary. Throws on failure so BullMQ retries; never logs the link (it carries a token).
 */
export async function processEmailJob(data: unknown, transport: MailTransport, from: string): Promise<void> {
  const job = emailJob.parse(data);
  const { subject, text, html } = renderEmail(job);
  await transport.sendMail({ from, to: job.to, subject, text, html });
}
