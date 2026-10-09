'use client';

import type { ConversationSummary } from '@sc/shared';
import { useI18n } from '../../lib/i18n';
import type { MessageKey } from '../../lib/messages';
import { Avatar, ChannelIcon, channelLabel } from './ui';

export function ContactPanel({ summary }: { summary: ConversationSummary }) {
  const { t } = useI18n();
  const rows: [MessageKey, string][] = [
    ['contact.channel', channelLabel(summary.channel.key)],
    ['contact.account', summary.channel.accountName],
    ['contact.status', t(`status.${summary.status}` as MessageKey)],
  ];
  return (
    <aside className="hidden h-full w-72 shrink-0 flex-col gap-5 overflow-y-auto border-l border-slate-200 bg-white p-5 xl:flex">
      <div className="flex flex-col items-center gap-3 text-center">
        <Avatar name={summary.contact.name} src={summary.contact.avatarUrl} size={72} />
        <div>
          <h2 className="text-base font-semibold">{summary.contact.name}</h2>
          <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-500">
            <ChannelIcon channel={summary.channel.key} size={14} />
            {channelLabel(summary.channel.key)}
          </p>
        </div>
      </div>
      <dl className="space-y-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-3">
            <dt className="text-slate-500">{t(label)}</dt>
            <dd className="truncate text-right font-medium">{value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
