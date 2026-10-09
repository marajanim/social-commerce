'use client';

import { useRouter } from 'next/navigation';
import { useI18n } from '../lib/i18n';
import { LOCALE_COOKIE } from '../lib/messages';

export function LanguageSwitch() {
  const { locale, t } = useI18n();
  const router = useRouter();
  function toggle() {
    const next = locale === 'en' ? 'bn' : 'en';
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }
  return (
    <button type="button" onClick={toggle} className="btn-ghost" lang={locale === 'en' ? 'bn' : 'en'}>
      {t('lang.switch')}
    </button>
  );
}
