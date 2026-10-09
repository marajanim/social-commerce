import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { CONFIG, type Config } from '../config';
import type { AuthedRequest } from './decorators';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence on top of SameSite=Lax: a state-changing request that carries an Origin header
 * must come from the web app's origin. Non-browser clients send no Origin and are not affected
 * (they cannot ride a victim's cookie).
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest & { method: string }>();
    if (SAFE.has(req.method)) return true;
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== this.config.WEB_ORIGIN) {
      throw new ForbiddenException('Cross-origin request refused');
    }
    return true;
  }
}
