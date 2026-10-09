import { describe, expect, it } from 'vitest';
import { processEmailJob } from './processor';
import { renderEmail } from './templates';

const link = 'http://localhost:3000/reset-password?token=abc_DEF-123';

describe('renderEmail', () => {
  it('renders English and Bangla copy that contains the link', () => {
    for (const locale of ['en', 'bn'] as const) {
      const mail = renderEmail({ template: 'password-reset', locale, link });
      expect(mail.text).toContain(link);
      expect(mail.html).toContain(`href="${link}"`);
    }
    expect(renderEmail({ template: 'verify-email', locale: 'bn', link }).subject).toMatch(/ইমেইল/);
  });

  it('escapes the link in HTML', () => {
    const mail = renderEmail({ template: 'verify-email', locale: 'en', link: 'http://x.test/?a=1&b="2"' });
    expect(mail.html).toContain('a=1&amp;b=&quot;2&quot;');
  });
});

describe('processEmailJob', () => {
  it('sends one message to the recipient', async () => {
    const sent: { to: string; subject: string }[] = [];
    await processEmailJob(
      { to: 'a@example.test', template: 'password-reset', link, locale: 'en' },
      { sendMail: async (m) => void sent.push({ to: m.to, subject: m.subject }) },
      'from@example.test',
    );
    expect(sent).toEqual([{ to: 'a@example.test', subject: 'Reset your password' }]);
  });

  it('rejects a malformed payload instead of sending', async () => {
    let called = false;
    await expect(
      processEmailJob({ to: 'not-an-email', template: 'password-reset', link }, { sendMail: async () => void (called = true) }, 'f@x.test'),
    ).rejects.toThrow();
    expect(called).toBe(false);
  });

  it('propagates transport errors so the queue retries', async () => {
    await expect(
      processEmailJob({ to: 'a@example.test', template: 'verify-email', link }, { sendMail: async () => { throw new Error('smtp down'); } }, 'f@x.test'),
    ).rejects.toThrow('smtp down');
  });
});
