'use client';

import type { ChannelAccountDto } from '@sc/shared';
import { useState, type FormEvent } from 'react';
import { apiPostJson } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

export function SimulateDialog(props: {
  channels: ChannelAccountDto[];
  onClose: () => void;
  onDelivered: (conversationId: string) => void;
}) {
  const { t } = useI18n();
  const usable = props.channels.filter((c) => c.status === 'connected');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(false);
    const r = await apiPostJson<{ conversationId: string }>('/dev/simulate-message', {
      channelAccountId: f.get('channel'),
      customerName: f.get('name'),
      text: f.get('text'),
    });
    setBusy(false);
    if (r.ok && r.data) props.onDelivered(r.data.conversationId);
    else setError(true);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" role="dialog" aria-modal="true" aria-labelledby="sim-title">
      <form onSubmit={submit} className="w-full max-w-md space-y-4 rounded-2xl bg-white p-6 shadow-xl">
        <div>
          <h2 id="sim-title" className="text-lg font-semibold">
            {t('inbox.sim.title')}
          </h2>
          <p className="mt-1 text-sm text-slate-500">{t('inbox.sim.hint')}</p>
        </div>
        {usable.length === 0 ? (
          <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{t('inbox.sim.noChannel')}</p>
        ) : (
          <>
            <div>
              <label htmlFor="sim-channel" className="mb-1.5 block text-sm font-medium">
                {t('inbox.sim.channel')}
              </label>
              <select id="sim-channel" name="channel" className="field" defaultValue={usable[0]?.id}>
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="sim-name" className="mb-1.5 block text-sm font-medium">
                {t('inbox.sim.name')}
              </label>
              <input id="sim-name" name="name" required maxLength={80} defaultValue="Rahim Uddin" className="field" />
            </div>
            <div>
              <label htmlFor="sim-text" className="mb-1.5 block text-sm font-medium">
                {t('inbox.sim.text')}
              </label>
              <textarea id="sim-text" name="text" required maxLength={2000} rows={3} defaultValue="দাদা, এই পাঞ্জাবিটার দাম কত?" className="field resize-none" />
            </div>
          </>
        )}
        {error ? (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {t('common.error')}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={props.onClose} className="btn-ghost">
            {t('inbox.sim.cancel')}
          </button>
          <button type="submit" disabled={busy || usable.length === 0} className="btn-primary !w-auto">
            {busy ? t('common.loading') : t('inbox.sim.send')}
          </button>
        </div>
      </form>
    </div>
  );
}
