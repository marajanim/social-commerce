import { Controller, Get, Inject, UnauthorizedException } from '@nestjs/common';
import { schema, type Database } from '@sc/db';
import type { MeResponse } from '@sc/shared';
import { eq } from 'drizzle-orm';
import { Auth, RequirePermission, type AuthContext } from '../../common/decorators';
import { DATABASE } from '../../db/db.module';
import { WorkspacesService } from './workspaces.service';

@Controller('me')
export class MeController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  @RequirePermission('account.self')
  @Get()
  async me(@Auth() auth: AuthContext): Promise<MeResponse> {
    const ctx = { tenantId: auth.tenantId, userId: auth.userId };
    const [user, tenant] = await this.db.tenantDb(ctx).transaction(async (tx) => [
      (await tx.select().from(schema.users).where(eq(schema.users.id, auth.userId)))[0],
      (await tx.select().from(schema.tenants).where(eq(schema.tenants.id, auth.tenantId)))[0],
    ]);
    if (!user || !tenant) throw new UnauthorizedException();
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        locale: user.locale,
        emailVerified: user.emailVerifiedAt !== null,
      },
      workspace: { tenantId: tenant.id, name: tenant.name, timezone: tenant.timezone, roleKey: auth.roleKey },
      workspaces: await this.workspaces.listFor(auth.userId),
      permissions: Object.fromEntries(auth.permissions),
    };
  }
}
