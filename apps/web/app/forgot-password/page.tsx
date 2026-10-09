'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { AuthCard } from '../../components/auth-card';
import { apiPost } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [state, setState] = useState<'idle' | 'busy' | 'sent' | 'error'>('idle');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState('busy');
    const res = await apiPost('/auth/forgot-password', { email: new FormData(e.currentTarget).get('email') });
    setState(res.ok ? 'sent' : 'error');
  }

  return (
    <AuthCard title={t('forgot.title')} subtitle={t('forgot.subtitle')}>
      {state === 'sent' ? (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {t('forgot.sent')}
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
              {t('common.email')}
            </label>
            <input id="email" name="email" type="email" autoComplete="email" required className="field" />
          </div>
          {state === 'error' ? (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {t('common.error')}
            </p>
          ) : null}
          <button type="submit" className="btn-primary" disabled={state === 'busy'}>
            {state === 'busy' ? t('common.loading') : t('forgot.submit')}
          </button>
        </form>
      )}
      <p className="mt-6 text-center text-sm">
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          {t('common.backToLogin')}
        </Link>
      </p>
    </AuthCard>
  );
}
