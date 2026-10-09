import type { Metadata } from 'next';
import { Inter, Noto_Sans_Bengali } from 'next/font/google';
import type { ReactNode } from 'react';
import { I18nProvider } from '../lib/i18n';
import { getLocale } from '../lib/server';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const bengali = Noto_Sans_Bengali({ subsets: ['bengali'], variable: '--font-bengali' });

export const metadata: Metadata = { title: 'Social Commerce' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${inter.variable} ${bengali.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        <I18nProvider locale={locale}>{children}</I18nProvider>
      </body>
    </html>
  );
}
