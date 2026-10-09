'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { AuthCard } from '../../components/auth-card';
import { apiPost } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../lib/messages';

function ResetForm() {
  const { t } = useI18n();
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<MessageKey | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get('password') ?? '');
    if (password.length < 10) return setError('reset.tooShort');
    setState('busy');
    setError(null);
    const res = await apiPost('/auth/reset-password', { token, password });
    if (res.ok) return setState('done');
    setState('idle');
    setError(res.status === 400 ? 'reset.invalid' : 'common.error');
  }

  return (
    <AuthCard title={t('reset.title')}>
      {state === 'done' ? (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {t('reset.done')}
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div>
            <label htmlFor="password" className="mb-1.5 block text-sm font-medium">
              {t('common.newPassword')}
            </label>
            <input id="password" name="password" type="password" autoComplete="new-password" required className="field" />
            <p className="mt-1 text-xs text-slate-500">{t('reset.hint')}</p>
          </div>
          {error ? (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {t(error)}
            </p>
          ) : null}
          <button type="submit" className="btn-primary" disabled={state === 'busy' || !token}>
            {state === 'busy' ? t('common.loading') : t('reset.submit')}
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

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  );
}
