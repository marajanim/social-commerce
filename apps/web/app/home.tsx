'use client';

import type { MeResponse } from '@sc/shared';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/messages';

const NEXT_STEPS: MessageKey[] = ['home.next.channels', 'home.next.inbox', 'home.next.catalog', 'home.next.ai'];

export function Home({ me }: { me: MeResponse }) {
  const { t } = useI18n();
  const role = t(`role.${me.workspace.roleKey}` as MessageKey);
  const grouped = new Map<string, [string, string][]>();
  for (const [key, scope] of Object.entries(me.permissions)) {
    const module = key.split('.')[0] ?? key;
    grouped.set(module, [...(grouped.get(module) ?? []), [key, scope]]);
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('home.welcome', { name: me.user.name })}</h1>
        <p className="mt-1 text-slate-600">{t('home.signedIn', { workspace: me.workspace.name, role })}</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm lg:col-span-2">
          <h2 className="text-base font-semibold">{t('home.accessTitle')}</h2>
          <p className="mt-1 text-sm text-slate-500">{t('home.accessHint')}</p>
          <dl className="mt-5 grid gap-4 sm:grid-cols-2">
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

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-base font-semibold">{t('home.nextTitle')}</h2>
          <ol className="mt-4 space-y-3">
            {NEXT_STEPS.map((key, i) => (
              <li key={key} className="flex items-start gap-3 text-sm">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-50 text-xs font-semibold text-brand-700">
                  {i + 1}
                </span>
                <span className="text-slate-700">{t(key)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}
