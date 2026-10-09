import { BadRequestException, Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { completeWhatsAppBody, connectWhatsAppBody, type ChannelAccountDto } from '@sc/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../../common/decorators';
import { ZodBodyPipe } from '../../common/zod-body.pipe';
import { CONFIG, type Config } from '../../config';
import { WhatsAppService } from './whatsapp.service';

const COOKIE = 'whatsapp_oauth_state';
@Controller('channels/whatsapp')
export class WhatsAppController {
  constructor(@Inject(WhatsAppService) private readonly service: WhatsAppService, @Inject(CONFIG) private readonly config: Config) {}
  @Get('setup')
  @RequirePermission('channels.manage')
  setup(@Res() reply: FastifyReply): void {
    if (!this.config.META_APP_ID || !this.config.META_APP_SECRET || !this.config.META_WHATSAPP_CONFIG_ID || !this.config.keyRing) throw new BadRequestException('WhatsApp Embedded Signup is not configured');
    const state = randomBytes(24).toString('base64url');
    void reply.header('Cache-Control', 'no-store').setCookie(COOKIE, state, { httpOnly: true, secure: this.config.cookieSecure, sameSite: 'lax', path: '/', maxAge: 600 })
      .send({ state, appId: this.config.META_APP_ID, configId: this.config.META_WHATSAPP_CONFIG_ID, version: 'v21.0' });
  }
  @Post('complete')
  @RequirePermission('channels.manage')
  async complete(@Auth() auth: AuthContext, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply, @Body(new ZodBodyPipe(completeWhatsAppBody)) body: z.infer<typeof completeWhatsAppBody>): Promise<ChannelAccountDto> {
    reply.clearCookie(COOKIE, { path: '/' });
    return this.service.complete(auth, body, req.cookies[COOKIE]);
  }
  @Post()
  @RequirePermission('channels.manage')
  connect(@Auth() auth: AuthContext, @Body(new ZodBodyPipe(connectWhatsAppBody)) body: z.infer<typeof connectWhatsAppBody>): Promise<ChannelAccountDto> { return this.service.connect(auth, body); }
  @Post(':id/resubscribe')
  @RequirePermission('channels.manage')
  retry(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<ChannelAccountDto> { return this.service.retry(auth, id); }
}
