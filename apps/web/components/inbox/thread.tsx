'use client';

import type { ConversationSummary, MessageDto, MessagePage, SendEligibilityDto } from '@sc/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { apiGet, apiPostJson } from '../../lib/api';
import { clockTime, dayLabel, duration } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../lib/messages';
import { Avatar, ChannelIcon, StatusTicks, channelLabel } from './ui';

interface LocalMessage {
  key: string;
  body: string;
  status: 'pending' | 'failed';
  reason?: string;
  createdAt: string;
}

const safeUrl = (u: string | undefined): string | null => {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
};

const mergeById = (prev: MessageDto[], incoming: MessageDto[]): MessageDto[] => {
  const map = new Map(prev.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
};

export function Thread(props: {
  summary: ConversationSummary;
  /** Bumped by the inbox whenever a realtime event touches this conversation. */
  version: number;
  canReply: boolean;
  onRead: (id: string) => void;
  onBack: () => void;
}) {
  const { t, locale } = useI18n();
  const { summary } = props;
  const id = summary.id;
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [older, setOlder] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [local, setLocal] = useState<LocalMessage[]>([]);
  const [elig, setElig] = useState<SendEligibilityDto | null>(null);
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const idRef = useRef(id);
  idRef.current = id;

  const loadEligibility = useCallback(async () => {
    const r = await apiGet<SendEligibilityDto>(`/conversations/${id}/send-eligibility`);
    if (idRef.current === id && r.data) setElig(r.data);
  }, [id]);

  const loadLatest = useCallback(
    async (reset: boolean) => {
      const r = await apiGet<MessagePage>(`/conversations/${id}/messages?limit=50`);
      if (idRef.current !== id || !r.data) return;
      const page = r.data;
      setMessages((prev) => (reset ? page.items : mergeById(prev, page.items)));
      if (reset) setOlder(page.olderCursor);
      setLoading(false);
      void apiPostJson(`/conversations/${id}/read`).then((res) => {
        if (res.ok) props.onRead(id);
      });
    },
    [id],
  );

  // Switching conversation starts fresh.
  useEffect(() => {
    setMessages([]);
    setOlder(null);
    setLocal([]);
    setElig(null);
    setDraft('');
    setLoading(true);
    stick.current = true;
    void loadLatest(true);
    void loadEligibility();
  }, [id, loadLatest, loadEligibility]);

  // A realtime event for this conversation: pull what changed.
  useEffect(() => {
    if (props.version === 0) return;
    void loadLatest(false);
    void loadEligibility();
  }, [props.version, loadLatest, loadEligibility]);

  // Keep the countdown honest, and re-check when a window runs out.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const expiresAt = elig?.windowExpiresAt ? new Date(elig.windowExpiresAt).getTime() : null;
  useEffect(() => {
    if (elig?.allowed && expiresAt !== null && expiresAt <= now && !elig.messageTag) void loadEligibility();
  }, [now, expiresAt, elig, loadEligibility]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, local.length, loading]);

  async function loadOlder() {
    if (!older) return;
    const el = scroller.current;
    const before = el?.scrollHeight ?? 0;
    const r = await apiGet<MessagePage>(`/conversations/${id}/messages?limit=50&beforeSeq=${older}`);
    if (idRef.current !== id || !r.data) return;
    const page = r.data;
    stick.current = false;
    setMessages((prev) => mergeById(prev, page.items));
    setOlder(page.olderCursor);
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  }

  const send = useCallback(
    async (body: string, key: string = crypto.randomUUID()) => {
      stick.current = true;
      setLocal((prev) => [
        ...prev.filter((m) => m.key !== key),
        { key, body, status: 'pending', createdAt: new Date().toISOString() },
      ]);
      const r = await apiPostJson<MessageDto>(`/conversations/${id}/messages`, { body }, { 'idempotency-key': key });
      if (idRef.current !== id) return;
      if (r.ok && r.data) {
        const sent = r.data;
        setMessages((prev) => mergeById(prev, [sent]));
        setLocal((prev) => prev.filter((m) => m.key !== key));
        void loadEligibility();
      } else {
        const reason = r.status === 409 ? ((r.data as { code?: string } | null)?.code ?? '') : '';
        setLocal((prev) => prev.map((m) => (m.key === key ? { ...m, status: 'failed', reason } : m)));
        if (r.status === 409) void loadEligibility();
      }
    },
    [id, loadEligibility],
  );

  function submit() {
    const body = draft.trim();
    if (!body || !elig?.allowed || !props.canReply) return;
    setDraft('');
    void send(body);
  }
  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  const rows = useMemo(() => {
    const out: ({ kind: 'day'; label: string } | { kind: 'msg'; m: MessageDto } | { kind: 'local'; m: LocalMessage })[] = [];
    let lastDay = '';
    const labels = { today: t('msg.today'), yesterday: t('msg.yesterday') };
    const push = (iso: string) => {
      const day = new Date(iso).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        out.push({ kind: 'day', label: dayLabel(iso, locale, labels) });
      }
    };
    for (const m of messages) {
      push(m.createdAt);
      out.push({ kind: 'msg', m });
    }
    for (const m of local) {
      push(m.createdAt);
      out.push({ kind: 'local', m });
    }
    return out;
  }, [messages, local, locale, t]);

  const windowNote = (() => {
    if (!elig) return null;
    if (!elig.allowed) {
      const key: MessageKey =
        elig.reason === 'no_inbound'
          ? 'window.noInbound'
          : elig.reason === 'channel_unavailable'
            ? 'window.channel'
            : 'window.closed';
      return { tone: 'bad' as const, text: t(key) };
    }
    if (elig.messageTag === 'HUMAN_AGENT') return { tone: 'warn' as const, text: t('window.humanAgent') };
    if (expiresAt === null) return { tone: 'ok' as const, text: t('window.none') };
    const left = expiresAt - now;
    return { tone: left < 2 * 3_600_000 ? ('warn' as const) : ('ok' as const), text: t('window.open', { time: duration(left) }) };
  })();
  const canType = props.canReply && elig?.allowed === true;

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <button type="button" onClick={props.onBack} className="-ml-1 rounded-lg p-1.5 text-slate-600 hover:bg-slate-100 md:hidden" aria-label={t('inbox.back')}>
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <Avatar name={summary.contact.name} src={summary.contact.avatarUrl} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{summary.contact.name}</h2>
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <ChannelIcon channel={summary.channel.key} size={14} />
            <span className="truncate">
              {channelLabel(summary.channel.key)} · {summary.channel.accountName}
            </span>
          </p>
        </div>
        <span className="hidden rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600 sm:inline">
          {t(`status.${summary.status}` as MessageKey)}
        </span>
      </header>

      <div
        ref={scroller}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
        }}
      >
        {older ? (
          <div className="mb-4 text-center">
            <button type="button" onClick={() => void loadOlder()} className="btn-ghost">
              {t('inbox.loadOlder')}
            </button>
          </div>
        ) : null}
        {loading ? <p className="py-10 text-center text-sm text-slate-400">{t('common.loading')}</p> : null}
        <ol className="space-y-1.5">
          {rows.map((row, i) => {
            if (row.kind === 'day') {
              return (
                <li key={`d${i}`} className="py-2 text-center">
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-medium text-slate-500 shadow-sm ring-1 ring-slate-200">{row.label}</span>
                </li>
              );
            }
            if (row.kind === 'local') return <LocalBubble key={row.m.key} m={row.m} onRetry={() => void send(row.m.body, row.m.key)} />;
            return <Bubble key={row.m.id} m={row.m} />;
          })}
        </ol>
      </div>

      <div className="border-t border-slate-200 bg-white p-3">
        {windowNote ? (
          <p
            className={`mb-2 rounded-lg px-3 py-1.5 text-xs font-medium ${windowNote.tone === 'bad' ? 'bg-red-50 text-red-700' : windowNote.tone === 'warn' ? 'bg-amber-50 text-amber-800' : 'bg-slate-100 text-slate-600'}`}
          >
            {windowNote.text}
          </p>
        ) : null}
        {!props.canReply ? (
          <p className="rounded-lg bg-slate-100 px-3 py-2.5 text-sm text-slate-600">{t('composer.readOnly')}</p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKey}
              rows={2}
              maxLength={2000}
              disabled={!canType}
              placeholder={t('composer.placeholder')}
              aria-label={t('composer.placeholder')}
              className="field max-h-40 min-h-[3rem] flex-1 resize-none disabled:bg-slate-100"
            />
            <button type="button" onClick={submit} disabled={!canType || draft.trim() === ''} className="btn-primary !w-auto self-stretch !px-5">
              {t('composer.send')}
            </button>
          </div>
        )}
        {canType ? <p className="mt-1.5 text-xs text-slate-400">{t('composer.hint')}</p> : null}
      </div>
    </div>
  );
}

function Attachments({ m }: { m: MessageDto }) {
  const { t } = useI18n();
  const labelFor: Record<string, MessageKey> = {
    image: 'msg.photo',
    video: 'msg.video',
    audio: 'msg.audio',
    file: 'msg.file',
    sticker: 'msg.sticker',
  };
  if (m.contentType === 'unsupported' && m.attachments.length === 0 && !m.body) {
    return <p className="italic opacity-80">{t('msg.unsupported')}</p>;
  }
  return (
    <>
      {m.attachments.map((a, i) => {
        const url = safeUrl(a.url);
        if ((a.type === 'image' || m.contentType === 'sticker') && url) {
          return <img key={i} src={url} alt={t(labelFor[a.type] ?? 'msg.photo')} referrerPolicy="no-referrer" loading="lazy" className="mb-1 max-h-72 rounded-lg" />;
        }
        const label = t(labelFor[a.type] ?? 'msg.file');
        return url ? (
          <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="mb-1 block underline">
            {label}
          </a>
        ) : (
          <p key={i} className="mb-1 opacity-80">
            {label}
          </p>
        );
      })}
    </>
  );
}

function Bubble({ m }: { m: MessageDto }) {
  const { t, locale } = useI18n();
  const mine = m.direction === 'outbound';
  return (
    <li className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${mine ? 'rounded-br-md bg-brand-600 text-white' : 'rounded-bl-md bg-white text-slate-900 ring-1 ring-slate-200'}`}
      >
        {m.fromExternalApp ? <p className="mb-0.5 text-[11px] font-medium opacity-80">{t('msg.external')}</p> : null}
        <Attachments m={m} />
        {m.body ? <p className="whitespace-pre-wrap break-words">{m.body}</p> : null}
        <p className={`mt-1 flex items-center justify-end gap-1 text-[11px] ${mine ? 'text-white/75' : 'text-slate-400'}`}>
          <span>{clockTime(m.createdAt, locale)}</span>
          {mine ? <StatusTicks status={m.status} /> : null}
        </p>
        {m.status === 'failed' ? (
          <p className="mt-1 text-xs text-red-100" role="status">
            {t('msg.failed')}
            {m.failureReason ? `: ${m.failureReason}` : ''}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function LocalBubble({ m, onRetry }: { m: LocalMessage; onRetry: () => void }) {
  const { t, locale } = useI18n();
  return (
    <li className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-brand-600/80 px-3.5 py-2 text-sm text-white shadow-sm">
        <p className="whitespace-pre-wrap break-words">{m.body}</p>
        <p className="mt-1 flex items-center justify-end gap-1 text-[11px] text-white/75">
          <span>{clockTime(m.createdAt, locale)}</span>
          <StatusTicks status={m.status} />
        </p>
        {m.status === 'failed' ? (
          <p className="mt-1 text-xs text-red-100" role="alert">
            {m.reason ? t('window.closed') : t('composer.failed')}{' '}
            {!m.reason ? (
              <button type="button" onClick={onRetry} className="font-semibold underline">
                ↻
              </button>
            ) : null}
          </p>
        ) : null}
      </div>
    </li>
  );
}
