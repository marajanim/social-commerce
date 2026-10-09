'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { AuthCard } from '../../components/auth-card';
import { apiPost } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

function Verify() {
  const { t } = useI18n();
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'busy' | 'done' | 'invalid'>('busy');
  const started = useRef(false);

  useEffect(() => {
    // The token is single-use: guard against React strict mode running the effect twice.
    if (started.current) return;
    started.current = true;
    void apiPost('/auth/verify-email', { token }).then((res) => setState(res.ok ? 'done' : 'invalid'));
  }, [token]);

  return (
    <AuthCard title={t('verify.title')}>
      {state === 'busy' ? <p className="text-sm text-slate-500">{t('common.loading')}</p> : null}
      {state === 'done' ? (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {t('verify.done')}
        </p>
      ) : null}
      {state === 'invalid' ? (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {t('verify.invalid')}
        </p>
      ) : null}
      <p className="mt-6 text-center text-sm">
        <Link href="/" className="font-medium text-brand-600 hover:underline">
          {t('common.backToLogin')}
        </Link>
      </p>
    </AuthCard>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  );
}
