'use client';

import Link from 'next/link';
import { can, useMe } from '../lib/me-context';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/messages';

export function Home() {
  const me = useMe();
  const { t } = useI18n();
  const role = t(`role.${me.workspace.roleKey}` as MessageKey);
  const grouped = new Map<string, [string, string][]>();
  for (const [key, scope] of Object.entries(me.permissions)) {
    const module = key.split('.')[0] ?? key;
    grouped.set(module, [...(grouped.get(module) ?? []), [key, scope]]);
  }

  return (
    <div className="space-y-8 p-5 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('home.welcome', { name: me.user.name })}</h1>
        <p className="mt-1 text-slate-600">{t('home.signedIn', { workspace: me.workspace.name, role })}</p>
        {can(me, 'inbox.view') ? (
          <Link href="/inbox" className="btn-primary mt-4 !w-auto">
            {t('nav.inbox')}
          </Link>
        ) : null}
      </div>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold">{t('home.accessTitle')}</h2>
        <p className="mt-1 text-sm text-slate-500">{t('home.accessHint')}</p>
        <dl className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...grouped].map(([module, perms]) => (
            <div key={module} className="rounded-xl bg-slate-50 p-4">
              <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{module}</dt>
              <dd className="mt-2 flex flex-wrap gap-1.5">
                {perms.map(([key, scope]) => (
                  <span
                    key={key}
                    className="rounded-full bg-white px-2.5 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-200"
                  >
                    {key.split('.').slice(1).join('.')}
                    <span className="ml-1 text-slate-400">· {t(`scope.${scope}` as MessageKey)}</span>
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
