'use client';

import type { ChannelAccountDto, ConversationSummary } from '@sc/shared';
import { listTime } from '../../lib/format';
import { useI18n } from '../../lib/i18n';
import { Avatar, ChannelIcon } from './ui';

export type ListFilter = 'all' | 'unread';

export function ConversationList(props: {
  items: ConversationSummary[];
  loading: boolean;
  hasMore: boolean;
  selectedId: string | null;
  filter: ListFilter;
  channelId: string;
  query: string;
  channels: ChannelAccountDto[];
  connected: boolean;
  canSimulate: boolean;
  onSelect: (id: string) => void;
  onFilter: (f: ListFilter) => void;
  onChannel: (id: string) => void;
  onQuery: (q: string) => void;
  onLoadMore: () => void;
  onSimulate: () => void;
}) {
  const { t, locale } = useI18n();
  const filtering = props.filter !== 'all' || props.channelId !== '' || props.query !== '';

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="space-y-3 border-b border-slate-200 p-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold tracking-tight">{t('inbox.title')}</h1>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${props.connected ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${props.connected ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {props.connected ? t('inbox.live') : t('inbox.offline')}
          </span>
        </div>
        <input
          type="search"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          placeholder={t('inbox.search')}
          aria-label={t('inbox.search')}
          className="field !py-2"
        />
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg bg-slate-100 p-0.5 text-sm" role="tablist">
            {(['all', 'unread'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={props.filter === f}
                onClick={() => props.onFilter(f)}
                className={`rounded-md px-3 py-1 font-medium ${props.filter === f ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
              >
                {t(f === 'all' ? 'inbox.filter.all' : 'inbox.filter.unread')}
              </button>
            ))}
          </div>
          {props.channels.length > 1 ? (
            <select
              value={props.channelId}
              onChange={(e) => props.onChannel(e.target.value)}
              aria-label={t('inbox.filter.channel')}
              className="field !w-auto min-w-0 flex-1 !py-1.5 text-sm"
            >
              <option value="">{t('inbox.filter.channel')}</option>
              {props.channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.displayName}
                </option>
              ))}
            </select>
          ) : null}
        </div>
        {props.canSimulate ? (
          <button type="button" onClick={props.onSimulate} className="btn-ghost w-full border-dashed text-slate-600">
            + {t('inbox.simulate')}
          </button>
        ) : null}
      </div>

      <ul className="min-h-0 flex-1 divide-y divide-slate-100 overflow-y-auto" aria-label={t('inbox.title')}>
        {props.items.map((c) => {
          const active = c.id === props.selectedId;
          return (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => props.onSelect(c.id)}
                aria-current={active ? 'true' : undefined}
                className={`flex w-full items-start gap-3 px-3 py-3 text-left transition ${active ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
              >
                <span className="relative">
                  <Avatar name={c.contact.name} src={c.contact.avatarUrl} />
                  <span className="absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-white">
                    <ChannelIcon channel={c.channel.key} size={16} />
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={`truncate text-sm ${c.unreadCount > 0 ? 'font-semibold' : 'font-medium'}`}>{c.contact.name}</span>
                    <span className="shrink-0 text-xs text-slate-400">{listTime(c.lastMessageAt, locale)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className={`truncate text-sm ${c.unreadCount > 0 ? 'text-slate-800' : 'text-slate-500'}`}>{c.preview ?? ''}</span>
                    {c.unreadCount > 0 ? (
                      <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">
                        {c.unreadCount > 99 ? '99+' : c.unreadCount}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {props.items.length === 0 && !props.loading ? (
          <li className="p-8 text-center text-sm text-slate-500">{filtering ? t('inbox.noMatch') : t('inbox.empty.body')}</li>
        ) : null}
        {props.loading && props.items.length === 0 ? (
          <li aria-hidden className="space-y-3 p-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex animate-pulse items-center gap-3">
                <span className="h-10 w-10 rounded-full bg-slate-200" />
                <span className="flex-1 space-y-2">
                  <span className="block h-3 w-1/2 rounded bg-slate-200" />
                  <span className="block h-3 w-4/5 rounded bg-slate-100" />
                </span>
              </div>
            ))}
          </li>
        ) : null}
        {props.hasMore ? (
          <li className="p-3">
            <button type="button" onClick={props.onLoadMore} className="btn-ghost w-full">
              {t('inbox.loadMore')}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
