import { Module } from '@nestjs/common';
import { DevController } from '../dev/dev.controller';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { HttpMetaGraph, META_GRAPH } from './meta-graph';

@Module({
  controllers: [ChannelsController, DevController],
  providers: [ChannelsService, { provide: META_GRAPH, useClass: HttpMetaGraph }],
})
export class ChannelsModule {}
