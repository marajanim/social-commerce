'use client';

import type { ChannelAccountDto, ChannelSetupDto, ConversationPage, ConversationSummary } from '@sc/shared';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { can, useMe } from '../../lib/me-context';
import { useRealtime, type RealtimeEvent } from '../../lib/realtime';
import { ContactPanel } from './contact-panel';
import { ConversationList, type ListFilter } from './conversation-list';
import { SimulateDialog } from './simulate-dialog';
import { Thread } from './thread';

const byRecency = (a: ConversationSummary, b: ConversationSummary) =>
  (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? '') || b.id.localeCompare(a.id);

export function InboxApp() {
  const me = useMe();
  const { t } = useI18n();
  const params = useSearchParams();
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<ListFilter>('all');
  const [channelId, setChannelId] = useState('');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(params.get('c'));
  const [deepLinked, setDeepLinked] = useState<ConversationSummary | null>(null);
  const [version, setVersion] = useState(0);
  const [channels, setChannels] = useState<ChannelAccountDto[] | null>(null);
  const [simulator, setSimulator] = useState(false);
  const [showSim, setShowSim] = useState(false);
  const request = useRef(0);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const filtersRef = useRef({ filter, channelId, query: debouncedQuery });
  filtersRef.current = { filter, channelId, query: debouncedQuery };

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const buildQuery = useCallback((after?: string | null) => {
    const f = filtersRef.current;
    const p = new URLSearchParams({ limit: '30' });
    if (f.filter === 'unread') p.set('unread', 'true');
    if (f.channelId) p.set('channelAccountId', f.channelId);
    if (f.query) p.set('q', f.query);
    if (after) p.set('cursor', after);
    return `/conversations?${p.toString()}`;
  }, []);

  const loadList = useCallback(
    async (more = false) => {
      const mine = ++request.current;
      if (!more) setLoading(true);
      const r = await apiGet<ConversationPage>(buildQuery(more ? cursorRef.current : null));
      if (mine !== request.current || !r.data) {
        if (mine === request.current) setLoading(false);
        return;
      }
      const page = r.data;
      setItems((prev) => (more ? [...prev, ...page.items.filter((n) => !prev.some((p) => p.id === n.id))] : page.items));
      setCursor(page.nextCursor);
      setLoading(false);
    },
    [buildQuery],
  );
  const cursorRef = useRef<string | null>(null);
  cursorRef.current = cursor;

  useEffect(() => {
    void loadList(false);
  }, [filter, channelId, debouncedQuery, loadList]);

  useEffect(() => {
    void apiGet<ChannelAccountDto[]>('/channels').then((r) => setChannels(r.data ?? []));
    if (can(me, 'channels.manage')) {
      void apiGet<ChannelSetupDto>('/channels/setup').then((r) => setSimulator(r.data?.simulatorEnabled ?? false));
    }
  }, [me]);

  // A conversation opened by link may not be on the first page.
  useEffect(() => {
    if (!selectedId || items.some((c) => c.id === selectedId)) return;
    void apiGet<ConversationSummary>(`/conversations/${selectedId}`).then((r) => setDeepLinked(r.data));
  }, [selectedId, items]);

  const refreshOne = useCallback(
    async (conversationId: string) => {
      const r = await apiGet<ConversationSummary>(`/conversations/${conversationId}`);
      if (!r.data) return;
      const fresh = r.data;
      const f = filtersRef.current;
      if (f.filter !== 'all' || f.channelId || f.query) {
        void loadList(false); // a filtered view: let the server decide what belongs
        return;
      }
      setItems((prev) => [fresh, ...prev.filter((c) => c.id !== fresh.id)].sort(byRecency));
    },
    [loadList],
  );

  const onEvent = useCallback(
    (e: RealtimeEvent) => {
      const cid = e.payload.conversationId;
      if (!cid) return;
      void refreshOne(cid);
      if (cid === selectedRef.current) setVersion((v) => v + 1);
    },
    [refreshOne],
  );
  const onReconnect = useCallback(() => {
    void loadList(false);
    setVersion((v) => v + 1);
  }, [loadList]);
  const { connected } = useRealtime({ onEvent, onReconnect });

  const select = (id: string | null) => {
    setSelectedId(id);
    setVersion(0);
    window.history.replaceState(null, '', id ? `/inbox?c=${id}` : '/inbox');
  };
  const markRead = useCallback((id: string) => {
    setItems((prev) => prev.map((c) => (c.id === id && c.unreadCount > 0 ? { ...c, unreadCount: 0 } : c)));
  }, []);

  const selected = items.find((c) => c.id === selectedId) ?? (deepLinked?.id === selectedId ? deepLinked : null);
  const noChannels = channels !== null && channels.length === 0;

  if (noChannels) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-sm rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-lg font-semibold">{t('inbox.empty.title')}</h1>
          <p className="mt-2 text-sm text-slate-500">{t('inbox.empty.body')}</p>
          {can(me, 'channels.view') ? (
            <Link href="/channels" className="btn-primary mt-5">
              {t('inbox.empty.connect')}
            </Link>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <section className={`${selectedId ? 'hidden md:flex' : 'flex'} h-full w-full shrink-0 flex-col border-r border-slate-200 md:w-80 lg:w-96`}>
        <ConversationList
          items={items}
          loading={loading}
          hasMore={cursor !== null}
          selectedId={selectedId}
          filter={filter}
          channelId={channelId}
          query={query}
          channels={channels ?? []}
          connected={connected}
          canSimulate={simulator}
          onSelect={select}
          onFilter={setFilter}
          onChannel={setChannelId}
          onQuery={setQuery}
          onLoadMore={() => void loadList(true)}
          onSimulate={() => setShowSim(true)}
        />
      </section>

      <section className={`${selectedId ? 'flex' : 'hidden md:flex'} min-w-0 flex-1`}>
        {selected ? (
          <>
            <div className="min-w-0 flex-1">
              <Thread
                key={selected.id}
                summary={selected}
                version={version}
                canReply={can(me, 'inbox.reply')}
                onRead={markRead}
                onBack={() => select(null)}
              />
            </div>
            <ContactPanel summary={selected} />
          </>
        ) : (
          <div className="flex h-full flex-1 flex-col items-center justify-center gap-2 bg-slate-50 p-6 text-center">
            <p className="text-base font-semibold text-slate-700">{t('inbox.select')}</p>
            <p className="max-w-xs text-sm text-slate-500">{t('inbox.selectHint')}</p>
          </div>
        )}
      </section>

      {showSim ? (
        <SimulateDialog
          channels={channels ?? []}
          onClose={() => setShowSim(false)}
          onDelivered={(cid) => {
            setShowSim(false);
            void refreshOne(cid);
          }}
        />
      ) : null}
    </div>
  );
}
