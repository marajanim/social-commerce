'use client';

import type { ChannelAccountDto, ChannelSetupDto, MetaPendingPagesDto } from '@sc/shared';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiDelete, apiGet, apiPostJson } from '../../lib/api';
import { relativeFromNow } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { can, useMe } from '../../lib/me-context';
import type { MessageKey } from '../../lib/messages';
import { ChannelIcon } from '../inbox/ui';

const STATUS_STYLE: Record<ChannelAccountDto['status'], string> = {
  connected: 'bg-emerald-50 text-emerald-700',
  connecting: 'bg-slate-100 text-slate-600',
  needs_attention: 'bg-amber-50 text-amber-800',
  disconnected: 'bg-red-50 text-red-700',
};

const OAUTH_ERRORS = ['state', 'denied', 'exchange', 'no_pages', 'taken', 'subscribe', 'not_configured'];

function CopyField({ label, value }: { label: string; value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-slate-500">{label}</p>
      <div className="flex gap-2">
        <input readOnly value={value} className="field !py-2 font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <button
          type="button"
          className="btn-ghost shrink-0"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? t('channels.copied') : t('channels.copy')}
        </button>
      </div>
    </div>
  );
}

export function ChannelsPage() {
  const me = useMe();
  const { t, locale } = useI18n();
  const params = useSearchParams();
  const manage = can(me, 'channels.manage');
  const [accounts, setAccounts] = useState<ChannelAccountDto[] | null>(null);
  const [setup, setSetup] = useState<ChannelSetupDto | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [pending, setPending] = useState<MetaPendingPagesDto | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await apiGet<ChannelAccountDto[]>('/channels');
    setAccounts(r.data ?? []);
  }, []);

  useEffect(() => {
    void load();
    if (manage) void apiGet<ChannelSetupDto>('/channels/setup').then((r) => setSetup(r.data));
  }, [load, manage]);

  // Coming back from Facebook: the API redirected here with the outcome in the address.
  useEffect(() => {
    const pick = params.get('pick');
    const error = params.get('error');
    if (params.get('connected')) setMessage({ tone: 'ok', text: t('channels.fb.connectedNow') });
    else if (error && OAUTH_ERRORS.includes(error)) setMessage({ tone: 'bad', text: t(`channels.fb.err.${error}` as MessageKey) });
    if (pick) {
      void apiGet<MetaPendingPagesDto>(`/channels/meta/pending/${pick}`).then((r) => {
        if (r.data) setPending(r.data);
        else setMessage({ tone: 'bad', text: t('channels.fb.pick.expired') });
      });
    }
    if (params.toString()) window.history.replaceState(null, '', '/channels');
  }, [params, t]);

  async function connectPicked(pageId: string) {
    if (!pending) return;
    setBusy(true);
    const r = await apiPostJson(`/channels/meta/pending/${pending.id}/connect`, { pageId });
    setBusy(false);
    if (r.ok) {
      setPending(null);
      setMessage({ tone: 'ok', text: t('channels.fb.connectedNow') });
      void load();
    } else {
      setMessage({ tone: 'bad', text: r.status === 409 ? t('channels.fb.err.taken') : t('channels.fb.pick.expired') });
      if (r.status !== 409) setPending(null);
    }
  }

  async function connectWithToken(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setBusy(true);
    setMessage(null);
    const name = String(f.get('name') ?? '').trim();
    const r = await apiPostJson('/channels/messenger', {
      pageId: String(f.get('pageId') ?? '').trim(),
      accessToken: String(f.get('token') ?? '').trim(),
      ...(name ? { displayName: name } : {}),
    });
    setBusy(false);
    if (r.ok) {
      form.reset();
      setMessage({ tone: 'ok', text: t('channels.fb.ok') });
      void load();
    } else {
      const key: MessageKey =
        r.status === 409
          ? 'channels.fb.error.taken'
          : r.status === 400 && /encryption/i.test(JSON.stringify(r.data))
            ? 'channels.fb.error.encryption'
            : 'channels.fb.error.token';
      setMessage({ tone: 'bad', text: t(key) });
    }
  }

  async function addDemo() {
    setBusy(true);
    await apiPostJson('/channels/demo');
    setBusy(false);
    void load();
  }

  async function disconnect(id: string) {
    if (!window.confirm(t('channels.disconnectConfirm'))) return;
    await apiDelete(`/channels/${id}`);
    void load();
  }

  const hasDemo = accounts?.some((a) => a.channelKey === 'webchat' && a.status === 'connected') ?? false;

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-5 sm:p-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('channels.title')}</h1>
        <p className="mt-1 text-slate-600">{t('channels.subtitle')}</p>
      </div>

      {message ? (
        <p role="status" className={`rounded-xl px-4 py-3 text-sm ${message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>
          {message.text}
        </p>
      ) : null}

      <section aria-labelledby="mine" className="space-y-3">
        <h2 id="mine" className="text-base font-semibold">
          {t('channels.connected')}
        </h2>
        {accounts === null ? <p className="text-sm text-slate-400">{t('common.loading')}</p> : null}
        {accounts?.length === 0 ? <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">{t('channels.none')}</p> : null}
        <ul className="grid gap-3 sm:grid-cols-2">
          {accounts?.map((a) => (
            <li key={a.id} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <ChannelIcon channel={a.channelKey} size={36} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{a.displayName}</p>
                <p className="truncate text-xs text-slate-500">{a.channelName} · {a.externalId}</p>
                <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  <span className={`rounded-full px-2 py-0.5 font-medium ${STATUS_STYLE[a.status]}`}>
                    {t(`channels.status.${a.status}` as MessageKey)}
                  </span>
                  <span className="text-slate-400">
                    {a.lastEventAt ? t('channels.lastEvent', { time: relativeFromNow(a.lastEventAt, locale) }) : t('channels.neverEvent')}
                  </span>
                </p>
              </div>
              {manage && a.status !== 'disconnected' ? (
                <button type="button" onClick={() => void disconnect(a.id)} className="text-xs font-medium text-red-600 hover:underline">
                  {t('channels.disconnect')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {manage ? (
        <>
          {pending ? (
            <section aria-labelledby="pick" className="rounded-2xl border-2 border-brand-500 bg-white p-6 shadow-sm">
              <h2 id="pick" className="text-base font-semibold">
                {t('channels.fb.pick.title')}
              </h2>
              {pending.pages.length === 0 ? <p className="mt-3 text-sm text-slate-500">{t('channels.fb.pick.none')}</p> : null}
              <ul className="mt-4 divide-y divide-slate-100">
                {pending.pages.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-3">
                    <span className="flex min-w-0 items-center gap-3">
                      <ChannelIcon channel="messenger" size={28} />
                      <span className="truncate font-medium">{p.name}</span>
                      <span className="text-xs text-slate-400">{p.id}</span>
                    </span>
                    <button type="button" disabled={busy} onClick={() => void connectPicked(p.id)} className="btn-primary !w-auto">
                      {t('channels.fb.pick.connect')}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="fb" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <ChannelIcon channel="messenger" size={32} />
              <div>
                <h2 id="fb" className="text-base font-semibold">
                  {t('channels.fb.title')}
                </h2>
                <p className="text-sm text-slate-500">{t('channels.fb.help')}</p>
              </div>
            </div>

            {setup?.oauthConfigured ? (
              <div className="mt-5">
                {/* A full page navigation: the browser leaves for Facebook and comes back to the API callback. */}
                <a href="/api/channels/meta/start" className="btn-primary !w-auto gap-2 !bg-[#1877f2] hover:!bg-[#1464cc]">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor" aria-hidden>
                    <path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.8-3.9 1.1 0 2.2.2 2.2.2v2.5h-1.3c-1.2 0-1.6.8-1.6 1.6V12h2.8l-.4 2.9h-2.3v7A10 10 0 0 0 22 12Z" />
                  </svg>
                  {t('channels.fb.continue')}
                </a>
                <p className="mt-2 text-sm text-slate-500">{t('channels.fb.continueHelp')}</p>
              </div>
            ) : setup ? (
              <div className="mt-5 space-y-3">
                <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t('channels.fb.notConfigured')}</p>
                <CopyField label={t('channels.fb.redirect')} value={setup.oauthRedirectUri} />
              </div>
            ) : null}

            <details className="mt-6 rounded-xl bg-slate-50 p-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-700">{t('channels.fb.advanced')}</summary>
              <form onSubmit={connectWithToken} className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="pageId" className="mb-1.5 block text-sm font-medium">
                    {t('channels.fb.pageId')}
                  </label>
                  <input id="pageId" name="pageId" required inputMode="numeric" pattern="\d{5,25}" className="field" />
                </div>
                <div>
                  <label htmlFor="pname" className="mb-1.5 block text-sm font-medium">
                    {t('channels.fb.pageName')}
                  </label>
                  <input id="pname" name="name" maxLength={120} className="field" />
                </div>
                <div className="sm:col-span-2">
                  <label htmlFor="token" className="mb-1.5 block text-sm font-medium">
                    {t('channels.fb.token')}
                  </label>
                  <input id="token" name="token" type="password" required minLength={20} autoComplete="off" className="field font-mono text-xs" />
                </div>
                {setup && !setup.encryptionConfigured ? (
                  <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 sm:col-span-2">{t('channels.fb.error.encryption')}</p>
                ) : null}
                <div className="sm:col-span-2">
                  <button type="submit" className="btn-primary !w-auto" disabled={busy}>
                    {busy ? t('common.loading') : t('channels.fb.connect')}
                  </button>
                </div>
              </form>
            </details>
          </section>

          <section aria-labelledby="hook" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 id="hook" className="text-base font-semibold">
              {t('channels.webhook.title')}
            </h2>
            <p className="mt-1 text-sm text-slate-500">{t('channels.webhook.help')}</p>
            {setup?.webhookUrl && setup.verifyToken ? (
              <div className="mt-4 grid gap-3">
                <CopyField label={t('channels.webhook.url')} value={setup.webhookUrl} />
                <CopyField label={t('channels.webhook.token')} value={setup.verifyToken} />
              </div>
            ) : (
              <p className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t('channels.webhook.missing')}</p>
            )}
          </section>

          <section aria-labelledby="demo" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3">
              <ChannelIcon channel="webchat" size={32} />
              <div className="flex-1">
                <h2 id="demo" className="text-base font-semibold">
                  {t('channels.demo.title')}
                </h2>
                <p className="text-sm text-slate-500">{t('channels.demo.help')}</p>
              </div>
              {hasDemo ? (
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">{t('channels.demo.ready')}</span>
              ) : (
                <button type="button" onClick={() => void addDemo()} disabled={busy} className="btn-ghost shrink-0">
                  {t('channels.demo.add')}
                </button>
              )}
            </div>
          </section>
        </>
      ) : null}

      <section className="rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-500">
        <p className="font-medium text-slate-700">{t('channels.later.title')}</p>
        <p className="mt-1 flex items-center gap-2">
          <ChannelIcon channel="instagram" size={18} />
          <ChannelIcon channel="whatsapp" size={18} />
          {t('channels.later.body')}
        </p>
      </section>
    </div>
  );
}
