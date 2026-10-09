'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '../../components/auth-card';
import { apiPost } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../lib/messages';

export function LoginForm() {
  const { t } = useI18n();
  const router = useRouter();
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const res = await apiPost('/auth/login', { email: form.get('email'), password: form.get('password') });
    if (res.ok) {
      router.replace('/');
      router.refresh();
      return;
    }
    setBusy(false);
    setError(
      res.status === 401 || res.status === 400
        ? 'login.invalid'
        : res.status === 429
          ? 'login.tooMany'
          : res.status === 403
            ? 'login.noWorkspace'
            : 'common.error',
    );
  }

  return (
    <AuthCard title={t('login.title')} subtitle={t('login.subtitle')}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div>
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
            {t('common.email')}
          </label>
          <input id="email" name="email" type="email" autoComplete="email" required className="field" />
        </div>
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label htmlFor="password" className="block text-sm font-medium">
              {t('common.password')}
            </label>
            <Link href="/forgot-password" className="text-xs font-medium text-brand-600 hover:underline">
              {t('login.forgot')}
            </Link>
          </div>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="field"
          />
        </div>
        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {t(error)}
          </p>
        ) : null}
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? t('common.loading') : t('login.submit')}
        </button>
      </form>
    </AuthCard>
  );
}
