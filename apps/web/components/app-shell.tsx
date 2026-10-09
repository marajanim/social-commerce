'use client';

import type { MeResponse } from '@sc/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { apiPost } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { MessageKey } from '../lib/messages';
import { Brand } from './brand';
import { LanguageSwitch } from './language-switch';

// A section appears only for roles that hold its permission. No href = not built yet.
const NAV: { key: MessageKey; permission: string; href?: string }[] = [
  { key: 'nav.inbox', permission: 'inbox.view', href: '/inbox' },
  { key: 'nav.channels', permission: 'channels.view', href: '/channels' },
  { key: 'nav.orders', permission: 'orders.view' },
  { key: 'nav.catalog', permission: 'catalog.view' },
  { key: 'nav.ai', permission: 'ai.view' },
  { key: 'nav.team', permission: 'members.view' },
  { key: 'nav.analytics', permission: 'analytics.view' },
  { key: 'nav.settings', permission: 'workspace.manage' },
];

export function AppShell({ me, children }: { me: MeResponse; children: ReactNode }) {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
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

  const items = NAV.filter((n) => n.permission in me.permissions);

  return (
    <div className="flex h-screen">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="border-b border-slate-100 p-5">
          <Brand compact />
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Main">
          <Link
            href="/"
            className={`block rounded-lg px-3 py-2 text-sm font-medium ${pathname === '/' ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}
          >
            {t('shell.home')}
          </Link>
          {items.map((n) =>
            n.href ? (
              <Link
                key={n.key}
                href={n.href}
                className={`block rounded-lg px-3 py-2 text-sm font-medium ${pathname.startsWith(n.href) ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-50'}`}
              >
                {t(n.key)}
              </Link>
            ) : (
              <div key={n.key} className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-slate-400" aria-disabled="true">
                <span>{t(n.key)}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                  {t('shell.soon')}
                </span>
              </div>
            ),
          )}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
          <div className="flex items-center gap-2 md:gap-3">
            <nav className="flex gap-1 md:hidden" aria-label="Mobile">
              {items
                .filter((n) => n.href)
                .map((n) => (
                  <Link
                    key={n.key}
                    href={n.href as string}
                    className={`rounded-lg px-2.5 py-1.5 text-sm font-medium ${pathname.startsWith(n.href as string) ? 'bg-brand-50 text-brand-700' : 'text-slate-600'}`}
                  >
                    {t(n.key)}
                  </Link>
                ))}
            </nav>
            <label htmlFor="workspace" className="hidden text-xs font-medium uppercase tracking-wide text-slate-500 sm:block">
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
            <span className="hidden text-sm text-slate-600 lg:inline">{me.user.email}</span>
            <LanguageSwitch />
            <button type="button" className="btn-ghost" onClick={() => void signOut()}>
              {t('shell.signOut')}
            </button>
          </div>
        </header>

        {!me.user.emailVerified ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-5 py-2 text-sm text-amber-900">
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

        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
