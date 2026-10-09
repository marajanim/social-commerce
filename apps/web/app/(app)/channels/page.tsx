import { Suspense } from 'react';
import { ChannelsPage } from '../../../components/channels/channels-page';

export default function ChannelsRoute() {
  return (
    <Suspense>
      <ChannelsPage />
    </Suspense>
  );
}
