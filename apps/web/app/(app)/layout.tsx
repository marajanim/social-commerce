import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { AppShell } from '../../components/app-shell';
import { MeProvider } from '../../lib/me-context';
import { getMe } from '../../lib/server';

// Everything inside this group needs a signed-in user; the API enforces permissions per request.
export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/login');
  return (
    <MeProvider me={me}>
      <AppShell me={me}>{children}</AppShell>
    </MeProvider>
  );
}
