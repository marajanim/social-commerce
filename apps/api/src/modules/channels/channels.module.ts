import { Module } from '@nestjs/common';
import { DevController } from '../dev/dev.controller';
import { ChannelsController } from './channels.controller';
import { ChannelsService } from './channels.service';
import { HttpMetaGraph, META_GRAPH } from './meta-graph';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService, HttpWhatsAppGraph, WHATSAPP_GRAPH } from './whatsapp.service';

@Module({
  controllers: [ChannelsController, WhatsAppController, DevController],
  providers: [ChannelsService, WhatsAppService, { provide: WHATSAPP_GRAPH, useClass: HttpWhatsAppGraph }, { provide: META_GRAPH, useClass: HttpMetaGraph }],
})
export class ChannelsModule {}
