import type { Locale } from './messages';

const INTL_LOCALE: Record<Locale, string> = { en: 'en-GB', bn: 'bn-BD' };

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? [parts[0], parts[parts.length - 1]] : [parts[0]];
  return letters.map((p) => Array.from(p ?? '')[0] ?? '').join('').toUpperCase() || '?';
}

/** A stable pastel background per name, so a customer keeps their colour everywhere. */
export function avatarColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return `hsl(${h} 55% 88%)`;
}

export function avatarInk(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return `hsl(${h} 45% 28%)`;
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "14:05" today, "Yesterday", weekday within a week, otherwise "12 Oct". */
export function listTime(iso: string | null, locale: Locale, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  const l = INTL_LOCALE[locale];
  if (sameDay(d, now)) return new Intl.DateTimeFormat(l, { hour: '2-digit', minute: '2-digit' }).format(d);
  const days = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (days < 7) return new Intl.DateTimeFormat(l, { weekday: 'short' }).format(d);
  return new Intl.DateTimeFormat(l, { day: 'numeric', month: 'short' }).format(d);
}

export function clockTime(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

export function dayLabel(iso: string, locale: Locale, labels: { today: string; yesterday: string }, now = new Date()): string {
  const d = new Date(iso);
  if (sameDay(d, now)) return labels.today;
  if (sameDay(d, new Date(now.getTime() - 86_400_000))) return labels.yesterday;
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
}

/** "3h 20m", "45m", "2d 4h". Used for the reply-window countdown. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${Math.max(m, 1)}m`;
}

export function relativeFromNow(iso: string, locale: Locale, now = new Date()): string {
  const diff = new Date(iso).getTime() - now.getTime();
  const rtf = new Intl.RelativeTimeFormat(INTL_LOCALE[locale], { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60_000) return rtf.format(0, 'second');
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
  return rtf.format(Math.round(diff / 86_400_000), 'day');
}
