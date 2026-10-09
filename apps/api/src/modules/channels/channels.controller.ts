import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { connectMessengerBody, type ChannelAccountDto, type ChannelSetupDto } from '@sc/shared';
import type { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../../common/decorators';
import { ZodBodyPipe } from '../../common/zod-body.pipe';
import { ChannelsService } from './channels.service';

@Controller('channels')
export class ChannelsController {
  constructor(@Inject(ChannelsService) private readonly channels: ChannelsService) {}

  @RequirePermission('channels.view')
  @Get()
  list(@Auth() auth: AuthContext): Promise<ChannelAccountDto[]> {
    return this.channels.list(auth);
  }

  /** Webhook URL and verify token to paste into the Meta app dashboard. */
  @RequirePermission('channels.manage')
  @Get('setup')
  setup(): ChannelSetupDto {
    return this.channels.setup();
  }

  @RequirePermission('channels.manage')
  @Post('messenger')
  connectMessenger(
    @Auth() auth: AuthContext,
    @Body(new ZodBodyPipe(connectMessengerBody)) body: z.infer<typeof connectMessengerBody>,
  ): Promise<ChannelAccountDto> {
    return this.channels.connectMessenger(auth, body);
  }

  @RequirePermission('channels.manage')
  @Post('demo')
  @HttpCode(200)
  demo(@Auth() auth: AuthContext): Promise<ChannelAccountDto> {
    return this.channels.ensureDemoChannel(auth);
  }

  @RequirePermission('channels.manage')
  @Delete(':id')
  @HttpCode(204)
  async disconnect(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.channels.disconnect(auth, id);
  }
}
