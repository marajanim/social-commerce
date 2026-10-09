import { Suspense } from 'react';
import { InboxApp } from '../../../components/inbox/inbox-app';

export default function InboxPage() {
  return (
    <Suspense>
      <InboxApp />
    </Suspense>
  );
}
