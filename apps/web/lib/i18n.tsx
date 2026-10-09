'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { MESSAGES, type Locale, type MessageKey } from './messages';

type Translate = (key: MessageKey, vars?: Record<string, string>) => string;

const I18nContext = createContext<{ locale: Locale; t: Translate } | null>(null);

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string>): string {
  let text: string = MESSAGES[locale][key];
  for (const [k, v] of Object.entries(vars ?? {})) text = text.replaceAll(`{${k}}`, v);
  return text;
}

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const t = useCallback<Translate>((key, vars) => translate(locale, key, vars), [locale]);
  return <I18nContext.Provider value={{ locale, t }}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>');
  return ctx;
}
