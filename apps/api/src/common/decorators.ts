import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { PermissionKey, PermissionScope } from '@sc/shared';

export const IS_PUBLIC = 'isPublic';
export const REQUIRED_PERMISSION = 'requiredPermission';

/** The route needs no login. Every route needs this or @RequirePermission; CI enforces it. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The route needs a session whose role grants this permission (any scope; services narrow by scope). */
export const RequirePermission = (key: PermissionKey) => SetMetadata(REQUIRED_PERMISSION, key);

/** What the guard resolved from the session. Tenant and user come from here, never from the request body. */
export interface AuthContext {
  userId: string;
  tenantId: string;
  sessionId: Buffer;
  roleKey: string;
  permissions: Map<string, PermissionScope>;
}

export interface AuthedRequest {
  auth?: AuthContext;
  headers: Record<string, string | string[] | undefined>;
  cookies: Record<string, string | undefined>;
  ip: string;
}

export const Auth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.auth) throw new Error('Auth context missing: route is not behind the auth guard');
  return req.auth;
});
