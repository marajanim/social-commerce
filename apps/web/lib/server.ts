import type { MeResponse } from '@sc/shared';
import { cookies } from 'next/headers';
import { LOCALE_COOKIE, LOCALES, type Locale } from './messages';

export const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4000';

export async function getLocale(): Promise<Locale> {
  const value = (await cookies()).get(LOCALE_COOKIE)?.value;
  return LOCALES.find((l) => l === value) ?? 'en';
}

/** The signed-in user, read on the server with the browser's session cookie. Null when signed out. */
export async function getMe(): Promise<MeResponse | null> {
  const cookie = (await cookies()).toString();
  if (!cookie) return null;
  try {
    const res = await fetch(`${API_ORIGIN}/me`, { headers: { cookie }, cache: 'no-store' });
    return res.ok ? ((await res.json()) as MeResponse) : null;
  } catch {
    return null;
  }
}
