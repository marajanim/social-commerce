'use client';

import type { ChannelKeyName, MessageDto } from '@sc/shared';
import { avatarColor, avatarInk, initials } from '../../lib/format';
import { useI18n } from '../../lib/i18n';

export function Avatar({ name, src, size = 40 }: { name: string; src?: string | null; size?: number }) {
  const style = { width: size, height: size, fontSize: size * 0.38 };
  if (src) {
    // Customer photos come from the channel's CDN; never send our page URL to them.
    return <img src={src} alt="" referrerPolicy="no-referrer" className="shrink-0 rounded-full object-cover" style={style} />;
  }
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ ...style, background: avatarColor(name), color: avatarInk(name) }}
    >
      {initials(name)}
    </span>
  );
}

const CHANNEL_STYLE: Record<ChannelKeyName, { label: string; bg: string; path: string }> = {
  messenger: {
    label: 'Messenger',
    bg: 'bg-[#0084ff]',
    path: 'M12 3C6.5 3 2.5 7 2.5 12c0 2.6 1.1 4.9 3 6.5V21l2.8-1.5c1 .3 2.1.5 3.2.5 5.5 0 9.5-4 9.5-9S17.5 3 12 3Zm1 11.3-2.4-2.5-4.6 2.5 5-5.3 2.5 2.5 4.5-2.5-5 5.3Z',
  },
  webchat: {
    label: 'Website',
    bg: 'bg-slate-600',
    path: 'M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4v-4H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  },
  whatsapp: {
    label: 'WhatsApp',
    bg: 'bg-[#25d366]',
    path: 'M12 2a10 10 0 0 0-8.6 15L2 22l5.1-1.3A10 10 0 1 0 12 2Zm5.1 13.6c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.3-.7-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.4-1.1-2.7s.7-1.9.9-2.2c.2-.2.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .5l-.3.5-.4.5c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.6-.1l2 1c.3.1.5.2.5.3.1.2.1.8-.1 1.5Z',
  },
  instagram: {
    label: 'Instagram',
    bg: 'bg-gradient-to-tr from-[#f9a43b] via-[#e1306c] to-[#8a3ab9]',
    path: 'M7.5 2h9A5.5 5.5 0 0 1 22 7.5v9a5.5 5.5 0 0 1-5.5 5.5h-9A5.5 5.5 0 0 1 2 16.5v-9A5.5 5.5 0 0 1 7.5 2Zm4.5 5.2a4.8 4.8 0 1 0 0 9.6 4.8 4.8 0 0 0 0-9.6Zm0 1.8a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm5.2-3.2a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z',
  },
};

export function channelLabel(key: ChannelKeyName): string {
  return CHANNEL_STYLE[key].label;
}

export function ChannelIcon({ channel, size = 16 }: { channel: ChannelKeyName; size?: number }) {
  const s = CHANNEL_STYLE[channel];
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center rounded-full text-white ${s.bg}`}
      style={{ width: size, height: size }}
      title={s.label}
    >
      <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: size * 0.62, height: size * 0.62 }} aria-hidden>
        <path d={s.path} />
      </svg>
      <span className="sr-only">{s.label}</span>
    </span>
  );
}

/** Delivery state of one of our own messages. */
export function StatusTicks({ status }: { status: MessageDto['status'] }) {
  const { t } = useI18n();
  if (status === 'pending') {
    return (
      <span title={t('msg.pending')} className="inline-flex items-center">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" strokeLinecap="round" />
        </svg>
        <span className="sr-only">{t('msg.pending')}</span>
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span title={t('msg.failed')} className="inline-flex items-center text-red-200">
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
          <path d="M12 2 1 21h22L12 2Zm1 14h-2v-2h2v2Zm0-4h-2V8h2v4Z" />
        </svg>
        <span className="sr-only">{t('msg.failed')}</span>
      </span>
    );
  }
  const double = status === 'delivered' || status === 'read';
  const label = t(status === 'read' ? 'msg.read' : status === 'delivered' ? 'msg.delivered' : 'msg.sent');
  return (
    <span title={label} className={`inline-flex items-center ${status === 'read' ? 'text-sky-200' : ''}`}>
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
        <path d="m4 12 5 5L20 6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {double ? (
        <svg viewBox="0 0 24 24" className="-ml-2 h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
          <path d="m4 12 5 5L20 6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : null}
      <span className="sr-only">{label}</span>
    </span>
  );
}
