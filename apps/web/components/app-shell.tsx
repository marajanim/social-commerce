'use client';

import type { MeResponse } from '@sc/shared';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { apiPost } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/messages';
import { Brand } from './brand';
import { LanguageSwitch } from './language-switch';

// Each section appears only for roles that hold its permission. All are "soon" until built.
const NAV: { key: MessageKey; permission: string }[] = [
  { key: 'nav.inbox', permission: 'inbox.view' },
  { key: 'nav.orders', permission: 'orders.view' },
  { key: 'nav.catalog', permission: 'catalog.view' },
  { key: 'nav.ai', permission: 'ai.view' },
  { key: 'nav.channels', permission: 'channels.view' },
  { key: 'nav.team', permission: 'members.view' },
  { key: 'nav.analytics', permission: 'analytics.view' },
  { key: 'nav.settings', permission: 'workspace.manage' },
];

export function AppShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const { t } = useI18n();
  const router = useRouter();
  const [verify, setVerify] = useState<'idle' | 'sent'>('idle');

  async function signOut() {
    await apiPost('/auth/logout');
    router.replace('/login');
    router.refresh();
  }

  async function switchWorkspace(tenantId: string) {
    const res = await apiPost('/auth/switch-workspace', { tenantId });
    if (res.ok) router.refresh();
  }

  async function sendVerification() {
    const res = await apiPost('/auth/send-verification');
    if (res.ok) setVerify('sent');
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-100 p-5">
          <Brand compact />
        </div>
        <nav className="flex-1 space-y-1 p-3" aria-label="Main">
          {NAV.filter((n) => n.permission in me.permissions).map((n) => (
            <div
              key={n.key}
              className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-slate-500"
              aria-disabled="true"
            >
              <span>{t(n.key)}</span>
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                {t('shell.soon')}
              </span>
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3">
          <div className="flex items-center gap-3">
            <label htmlFor="workspace" className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {t('shell.workspace')}
            </label>
            <select
              id="workspace"
              className="field !w-auto !py-1.5"
              value={me.workspace.tenantId}
              onChange={(e) => void switchWorkspace(e.target.value)}
            >
              {me.workspaces.map((w) => (
                <option key={w.tenantId} value={w.tenantId}>
                  {w.name} · {t(`role.${w.roleKey}` as MessageKey)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-sm text-slate-600 sm:inline">{me.user.email}</span>
            <LanguageSwitch />
            <button type="button" className="btn-ghost" onClick={() => void signOut()}>
              {t('shell.signOut')}
            </button>
          </div>
        </header>

        {!me.user.emailVerified ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-sm text-amber-900">
            <span>{t('shell.verifyBanner')}</span>
            {verify === 'sent' ? (
              <span role="status">{t('shell.verifySent')}</span>
            ) : (
              <button type="button" className="font-semibold underline" onClick={() => void sendVerification()}>
                {t('shell.verifySend')}
              </button>
            )}
          </div>
        ) : null}

        <main className="flex-1 p-5 sm:p-8">{children}</main>
      </div>
    </div>
  );
}
