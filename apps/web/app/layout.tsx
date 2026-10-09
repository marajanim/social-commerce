import type { ReactNode } from 'react';

export const metadata = { title: 'Social Commerce' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
