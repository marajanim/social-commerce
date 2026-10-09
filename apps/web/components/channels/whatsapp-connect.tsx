'use client';

import type { ChannelAccountDto } from '@sc/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { apiGet, apiPostJson } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { ChannelIcon } from '../inbox/ui';

interface SignupSetup { appId: string; configId: string; state: string; version: string }
function apiError(data: unknown, fallback: string): string {
  const message = (data as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : fallback;
}
function connectionMessage(account: ChannelAccountDto | null, bn: boolean): string {
  return account?.status === 'connected'
    ? (bn ? 'হোয়াটসঅ্যাপ সংযুক্ত হয়েছে। একটি নতুন মেসেজ পাঠিয়ে ইনবক্স পরীক্ষা করুন।' : 'WhatsApp connected. Send a new message to verify delivery in your inbox.')
    : (bn ? 'নম্বরটি সংরক্ষিত হয়েছে। মেটাতে নম্বর নিবন্ধন ও ওয়েবহুক সেটআপ সম্পূর্ণ করে আবার সেটআপ চেষ্টা করুন।' : 'Number saved. Complete number registration and webhook setup in Meta, then use Retry setup.');
}
interface FacebookSDK {
  init(options: { appId: string; version: string; cookie: boolean; xfbml: boolean }): void;
  login(callback: (response: { authResponse?: { code?: string } }) => void, options: Record<string, unknown>): void;
}
const sdk = () => (window as Window & { FB?: FacebookSDK }).FB;
let sdkPromise: Promise<FacebookSDK> | undefined;
function loadSdk(): Promise<FacebookSDK> {
  if (sdk()) return Promise.resolve(sdk() as FacebookSDK);
  return sdkPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js'; script.async = true;
    script.onload = () => sdk() ? resolve(sdk() as FacebookSDK) : reject(new Error('Facebook login did not load'));
    script.onerror = () => { sdkPromise = undefined; reject(new Error('Facebook login could not load. Check your connection or browser blocker.')); };
    document.body.appendChild(script);
  });
}

export function WhatsAppConnect({ configured, onConnected }: { configured: boolean; onConnected: () => void }) {
  const { locale } = useI18n();
  const bn = locale === 'bn';
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [coexistence, setCoexistence] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const setup = useRef<SignupSetup | null>(null);
  const attempt = useRef<{ code?: string; wabaId?: string; phoneNumberId?: string; submitted?: boolean } | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finish = useCallback(async () => {
    const a = attempt.current;
    if (!a?.code || !a.wabaId || !a.phoneNumberId || a.submitted || !setup.current) return;
    a.submitted = true;
    const r = await apiPostJson<ChannelAccountDto>('/channels/whatsapp/complete', { code: a.code, wabaId: a.wabaId, phoneNumberId: a.phoneNumberId, state: setup.current.state });
    if (timeout.current) clearTimeout(timeout.current);
    attempt.current = null; setBusy(false); setReady(false);
    setMessage(r.ok ? connectionMessage(r.data, bn) : apiError(r.data, 'Could not connect WhatsApp. Reload and try again.'));
    if (r.ok) onConnected();
    const next = await apiGet<SignupSetup>('/channels/whatsapp/setup');
    if (next.ok && next.data) { setup.current = next.data; setReady(true); }
  }, [bn, onConnected]);

  useEffect(() => {
    let active = true;
    if (configured) void Promise.all([apiGet<SignupSetup>('/channels/whatsapp/setup'), loadSdk()]).then(([r, fb]) => {
      if (!active) return;
      if (!r.ok || !r.data) { setMessage(apiError(r.data, 'WhatsApp setup could not load')); return; }
      setup.current = r.data; fb.init({ appId: r.data.appId, version: r.data.version, cookie: true, xfbml: false }); setReady(true);
    }).catch((e: Error) => { if (active) setMessage(e.message); });
    const listener = (event: MessageEvent) => {
      if (!attempt.current || !['https://www.facebook.com', 'https://web.facebook.com', 'https://business.facebook.com', 'https://facebook.com'].includes(event.origin)) return;
      try {
        const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
        if (data.event === 'FINISH' || data.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
          if (!/^\d{5,25}$/.test(data.data?.waba_id ?? '') || !/^\d{5,25}$/.test(data.data?.phone_number_id ?? '')) return;
          Object.assign(attempt.current, { wabaId: data.data.waba_id, phoneNumberId: data.data.phone_number_id }); void finish();
        } else if (data.event === 'CANCEL' || data.event === 'ERROR') {
          attempt.current = null; setBusy(false); setMessage(bn ? 'হোয়াটসঅ্যাপ সেটআপ সম্পূর্ণ হয়নি। আবার চেষ্টা করুন।' : 'WhatsApp setup was not completed. Try again.');
        }
      } catch { /* Other Facebook SDK messages are not signup results. */ }
    };
    window.addEventListener('message', listener);
    return () => { active = false; window.removeEventListener('message', listener); if (timeout.current) clearTimeout(timeout.current); };
  }, [configured, finish, bn]);

  function start() {
    if (!ready || !sdk() || !setup.current) return;
    attempt.current = {}; setBusy(true); setMessage(null);
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => { attempt.current = null; setBusy(false); setMessage('WhatsApp setup timed out. Reload and try again.'); }, 600_000);
    sdk()?.login(response => {
      if (!attempt.current) return;
      if (!response.authResponse?.code) { attempt.current = null; setBusy(false); setMessage(bn ? 'অনুমোদন সম্পূর্ণ হয়নি। আবার চেষ্টা করুন।' : 'Authorization was not completed. Try again.'); return; }
      attempt.current.code = response.authResponse.code; void finish();
    }, { config_id: setup.current.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {}, sessionInfoVersion: '3', ...(coexistence ? { featureType: 'whatsapp_business_app_onboarding' } : {}) } });
  }
  async function manual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const f = new FormData(form); setBusy(true); setMessage(null);
    const r = await apiPostJson<ChannelAccountDto>('/channels/whatsapp', { wabaId: String(f.get('wabaId')).trim(), phoneNumberId: String(f.get('phoneNumberId')).trim(), accessToken: String(f.get('accessToken')).trim() });
    setBusy(false);
    setMessage(r.ok ? connectionMessage(r.data, bn) : apiError(r.data, 'Could not connect WhatsApp'));
    if (r.ok) { form.reset(); onConnected(); }
  }
  return <section aria-labelledby="whatsapp-title" className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
    <label className="mb-4 flex items-center gap-2 text-sm"><input type="checkbox" checked={coexistence} disabled={busy} onChange={e => setCoexistence(e.target.checked)} />{bn ? 'ফোনের WhatsApp Business অ্যাপ ব্যবহার চালিয়ে যেতে চাই (Coexistence)' : 'Keep using my WhatsApp Business phone app (Coexistence)'}</label>
    <div className="flex items-center gap-3"><ChannelIcon channel="whatsapp" size={32} /><div><h2 id="whatsapp-title" className="font-semibold">WhatsApp Business</h2><p className="text-sm text-slate-500">{bn ? 'আপনার ব্যবসার নম্বর সংযুক্ত করে এই ইনবক্সে মেসেজ ও উত্তর পরিচালনা করুন।' : 'Connect your business number to receive messages and reply from this inbox.'}</p></div></div>
    <p className="mt-4 text-sm text-slate-600">{bn ? 'মেটার অনুমোদন সম্পূর্ণ করুন এবং ব্যবসার নম্বর যাচাই করুন। ব্যক্তিগত হোয়াটসঅ্যাপ সরাসরি সংযুক্ত করা যায় না।' : 'Complete Meta authorization and verify your business number. Personal WhatsApp accounts cannot connect directly.'}</p>
    <button type="button" className="btn-primary mt-4" onClick={start} disabled={!ready || busy}>{busy ? (bn ? 'সংযুক্ত হচ্ছে…' : 'Connecting…') : (bn ? 'হোয়াটসঅ্যাপ সংযুক্ত করুন' : 'Connect WhatsApp')}</button>
    {!configured && <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">{bn ? 'ওয়ান-ক্লিক সংযোগের জন্য মেটাতে WhatsApp Embedded Signup কনফিগারেশন সেটআপ করতে হবে।' : 'One-click connection needs a WhatsApp Embedded Signup configuration in Meta. An existing Cloud API number can connect below.'}</p>}
    {message && <p role="status" className="mt-3 rounded-lg bg-slate-50 p-3 text-sm">{message}</p>}
    <details className="mt-5 rounded-xl bg-slate-50 p-4"><summary className="cursor-pointer text-sm font-medium">{bn ? 'উন্নত: বিদ্যমান Cloud API নম্বর সংযুক্ত করুন' : 'Advanced: connect an existing Cloud API number'}</summary>
      <p className="mt-3 text-sm text-slate-600">{bn ? 'একই মেটা অ্যাপের টোকেনে whatsapp_business_management এবং whatsapp_business_messaging পারমিশন লাগবে।' : 'Use a token for this Meta app with whatsapp_business_management and whatsapp_business_messaging. The number must already be registered for Cloud API.'}</p>
      <form onSubmit={e => void manual(e)} className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">WhatsApp Business Account ID<input name="wabaId" required pattern="[0-9]{5,25}" className="field mt-1" /></label>
        <label className="text-sm">Phone number ID<input name="phoneNumberId" required pattern="[0-9]{5,25}" className="field mt-1" /></label>
        <label className="text-sm sm:col-span-2">Access token<input name="accessToken" type="password" autoComplete="off" required minLength={20} maxLength={4000} className="field mt-1" /></label>
        <button className="btn-primary justify-self-start" disabled={busy}>{bn ? 'নম্বর সংযুক্ত করুন' : 'Connect number'}</button>
      </form>
    </details>
    <p className="mt-4 text-sm text-slate-500">{bn ? 'মেটাতে WhatsApp Business Account ওয়েবহুকের messages ফিল্ড সাবস্ক্রাইব করুন। বিদ্যমান ফোন অ্যাপ রাখার জন্য Coexistence যোগ্যতা প্রয়োজন।' : 'In Meta, subscribe the WhatsApp Business Account webhook to messages. Keeping the existing phone app requires eligibility for Coexistence.'}</p>
  </section>;
}
