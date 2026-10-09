import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SESSION_COOKIE, SessionService } from '../modules/auth/session.service';
import { WorkspacesService } from '../modules/auth/workspaces.service';
import { IS_PUBLIC, REQUIRED_PERMISSION, type AuthedRequest } from './decorators';

/**
 * Global guard. A route is open only if marked @Public(); otherwise it needs a valid session,
 * an active membership in the session's workspace, and the permission named by
 * @RequirePermission. A route with neither decorator is refused (fail closed).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const required = this.reflector.getAllAndOverride<string | undefined>(REQUIRED_PERMISSION, targets);
    if (!required) throw new ForbiddenException('Route has no permission declared');

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) throw new UnauthorizedException();

    const session = await this.sessions.validate(token);
    if (!session?.tenantId) throw new UnauthorizedException();

    const membership = await this.workspaces.membership(session.userId, session.tenantId);
    if (!membership) throw new UnauthorizedException();

    if (!membership.permissions.has(required)) throw new ForbiddenException();

    req.auth = {
      userId: session.userId,
      tenantId: session.tenantId,
      sessionId: session.sessionId,
      roleKey: membership.roleKey,
      permissions: membership.permissions,
    };
    return true;
  }
}
