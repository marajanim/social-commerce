import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import {
  forgotPasswordBody,
  loginBody,
  resetPasswordBody,
  switchWorkspaceBody,
  verifyEmailBody,
  type LoginBody,
} from '@sc/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth, Public, RequirePermission, type AuthContext } from '../../common/decorators';
import { ZodBodyPipe } from '../../common/zod-body.pipe';
import { CONFIG, type Config } from '../../config';
import { AuthService } from './auth.service';
import { SESSION_COOKIE, SessionService } from './session.service';

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodBodyPipe(loginBody)) body: LoginBody,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ ok: true }> {
    const { token, expiresAt } = await this.auth.login(body.email, body.password, {
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
    return { ok: true };
  }

  @RequirePermission('account.self')
  @Post('logout')
  @HttpCode(200)
  async logout(@Auth() auth: AuthContext, @Res({ passthrough: true }) reply: FastifyReply): Promise<{ ok: true }> {
    await this.sessions.revoke(auth.sessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @RequirePermission('account.self')
  @Post('switch-workspace')
  @HttpCode(200)
  async switchWorkspace(
    @Auth() auth: AuthContext,
    @Body(new ZodBodyPipe(switchWorkspaceBody)) body: z.infer<typeof switchWorkspaceBody>,
  ): Promise<{ ok: true }> {
    await this.auth.switchWorkspace(auth.userId, auth.sessionId, body.tenantId);
    return { ok: true };
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(202)
  async forgotPassword(
    @Body(new ZodBodyPipe(forgotPasswordBody)) body: z.infer<typeof forgotPasswordBody>,
    @Req() req: FastifyRequest,
  ): Promise<{ ok: true }> {
    await this.auth.requestPasswordReset(body.email, req.ip);
    return { ok: true };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  async resetPassword(
    @Body(new ZodBodyPipe(resetPasswordBody)) body: z.infer<typeof resetPasswordBody>,
  ): Promise<{ ok: true }> {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }

  @RequirePermission('account.self')
  @Post('send-verification')
  @HttpCode(202)
  async sendVerification(@Auth() auth: AuthContext): Promise<{ ok: true }> {
    await this.auth.sendVerification(auth.userId);
    return { ok: true };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(
    @Body(new ZodBodyPipe(verifyEmailBody)) body: z.infer<typeof verifyEmailBody>,
  ): Promise<{ ok: true }> {
    await this.auth.verifyEmail(body.token);
    return { ok: true };
  }
}
