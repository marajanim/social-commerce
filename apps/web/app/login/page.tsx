import { redirect } from 'next/navigation';
import { getMe } from '../../lib/server';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  if (await getMe()) redirect('/');
  return <LoginForm />;
}
