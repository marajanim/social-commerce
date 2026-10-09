import { Body, Controller, Delete, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import {
  connectMessengerBody,
  connectPendingPageBody,
  type ChannelAccountDto,
  type ChannelSetupDto,
  type MetaPendingPagesDto,
} from '@sc/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../../common/decorators';
import { ZodBodyPipe } from '../../common/zod-body.pipe';
import { CONFIG, type Config } from '../../config';
import { ChannelsService } from './channels.service';

const STATE_COOKIE = 'meta_oauth_state';

@Controller('channels')
export class ChannelsController {
  constructor(
    @Inject(ChannelsService) private readonly channels: ChannelsService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @RequirePermission('channels.view')
  @Get()
  list(@Auth() auth: AuthContext): Promise<ChannelAccountDto[]> {
    return this.channels.list(auth);
  }

  /** Webhook URL, verify token and Facebook-login status for the channels page. */
  @RequirePermission('channels.manage')
  @Get('setup')
  setup(): ChannelSetupDto {
    return this.channels.setup();
  }

  /** "Continue with Facebook": remembers a one-time state in a cookie and sends the browser to Facebook. */
  @RequirePermission('channels.manage')
  @Get('meta/start')
  start(@Res() reply: FastifyReply): void {
    const { url, state } = this.channels.beginOAuth();
    void reply
      .setCookie(STATE_COOKIE, state, {
        httpOnly: true,
        secure: this.config.cookieSecure,
        sameSite: 'lax',
        path: '/',
        maxAge: 600,
      })
      .redirect(url, 302);
  }

  /** Facebook sends the browser back here with a one-time code. Always ends in a redirect to the web app. */
  @RequirePermission('channels.manage')
  @Get('meta/callback')
  async callback(
    @Auth() auth: AuthContext,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ): Promise<void> {
    const result = await this.channels.completeOAuth(auth, { code, state, error, cookieState: req.cookies[STATE_COOKIE] });
    const dest = new URL('/channels', this.config.WEB_ORIGIN);
    if (result.kind === 'connected') dest.searchParams.set('connected', result.accountId);
    else if (result.kind === 'pick') dest.searchParams.set('pick', result.sessionId);
    else dest.searchParams.set('error', result.code);
    void reply.clearCookie(STATE_COOKIE, { path: '/' }).redirect(dest.toString(), 302);
  }

  @RequirePermission('channels.manage')
  @Get('meta/pending/:id')
  pending(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<MetaPendingPagesDto> {
    return this.channels.pendingPages(auth, id);
  }

  @RequirePermission('channels.manage')
  @Post('meta/pending/:id/connect')
  @HttpCode(201)
  connectPending(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBodyPipe(connectPendingPageBody)) body: z.infer<typeof connectPendingPageBody>,
  ): Promise<ChannelAccountDto> {
    return this.channels.connectPending(auth, id, body.pageId);
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
