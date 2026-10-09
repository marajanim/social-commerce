import type { EmailJob } from '@sc/shared';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

type Copy = { subject: string; intro: string; action: string; outro: string };

const COPY: Record<EmailJob['template'], Record<EmailJob['locale'], Copy>> = {
  'password-reset': {
    en: {
      subject: 'Reset your password',
      intro: 'We received a request to reset your password.',
      action: 'Choose a new password',
      outro: 'This link works once and expires in 1 hour. If you did not ask for it, ignore this email.',
    },
    bn: {
      subject: 'আপনার পাসওয়ার্ড রিসেট করুন',
      intro: 'আপনার পাসওয়ার্ড রিসেট করার একটি অনুরোধ পেয়েছি।',
      action: 'নতুন পাসওয়ার্ড দিন',
      outro: 'লিংকটি একবারই কাজ করবে এবং ১ ঘণ্টা পর মেয়াদ শেষ হবে। আপনি অনুরোধ না করে থাকলে এই ইমেইল উপেক্ষা করুন।',
    },
  },
  'verify-email': {
    en: {
      subject: 'Confirm your email address',
      intro: 'Please confirm that this is your email address.',
      action: 'Confirm email',
      outro: 'This link works once and expires in 24 hours.',
    },
    bn: {
      subject: 'আপনার ইমেইল ঠিকানা নিশ্চিত করুন',
      intro: 'অনুগ্রহ করে নিশ্চিত করুন যে এটি আপনার ইমেইল ঠিকানা।',
      action: 'ইমেইল নিশ্চিত করুন',
      outro: 'লিংকটি একবারই কাজ করবে এবং ২৪ ঘণ্টা পর মেয়াদ শেষ হবে।',
    },
  },
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderEmail(job: Pick<EmailJob, 'template' | 'locale' | 'link'>): RenderedEmail {
  const c = COPY[job.template][job.locale];
  const href = escapeHtml(job.link);
  return {
    subject: c.subject,
    text: `${c.intro}\n\n${c.action}: ${job.link}\n\n${c.outro}\n`,
    html: `<p>${c.intro}</p><p><a href="${href}">${c.action}</a></p><p style="color:#666">${c.outro}</p>`,
  };
}
