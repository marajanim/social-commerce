import { Module } from '@nestjs/common';
import { QueuesModule } from '../../queues/email-queue';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { MeController } from './me.controller';
import { RateLimiter } from './rate-limiter';
import { SessionService } from './session.service';
import { WorkspacesService } from './workspaces.service';

@Module({
  imports: [QueuesModule],
  controllers: [AuthController, MeController],
  providers: [AuthService, SessionService, WorkspacesService, RateLimiter],
  exports: [SessionService, WorkspacesService],
})
export class AuthModule {}
