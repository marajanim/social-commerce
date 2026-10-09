import { Module } from '@nestjs/common';
import { InboxQueuesModule } from '../../queues/inbox-queues';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({
  imports: [InboxQueuesModule],
  controllers: [InboxController],
  providers: [InboxService],
})
export class InboxModule {}
