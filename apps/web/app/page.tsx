import { redirect } from 'next/navigation';
import { AppShell } from '../components/app-shell';
import { getMe } from '../lib/server';
import { Home } from './home';

export default async function HomePage() {
  const me = await getMe();
  if (!me) redirect('/login');
  return (
    <AppShell me={me}>
      <Home me={me} />
    </AppShell>
  );
}
