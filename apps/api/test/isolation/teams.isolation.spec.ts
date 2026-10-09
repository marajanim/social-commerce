import 'reflect-metadata';
import { Controller, Get, Inject, Module, NotFoundException, Param, Req } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createDatabase, schema, type Database } from '@sc/db';
import { createTenancyFixture, expectCrossTenantNotFound, type TenancyFixture } from '@sc/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it } from 'vitest';

/**
 * TEMPLATE for isolation tests. Copy this file for each new endpoint:
 *  1. mount the real controller (here a stand-in that reads `teams` through tenantDb),
 *  2. add one expectCrossTenantNotFound(...) call per route that takes an ID.
 * The stand-in authenticates with a test header; M0-6 replaces it with real sessions.
 */
@Controller('teams')
class TeamsProbeController {
  constructor(@Inject('DB') private readonly db: Database) {}

  @Get(':id')
  async get(@Param('id') id: string, @Req() req: { headers: Record<string, string | undefined> }) {
    const tenantId = req.headers['x-test-tenant'] ?? '';
    const rows = await this.db
      .tenantDb({ tenantId })
      .transaction((tx) => tx.select().from(schema.teams).where(eq(schema.teams.id, id)));
    const team = rows[0];
    if (!team) throw new NotFoundException();
    return { id: team.id };
  }
}

let fx: TenancyFixture;
let app: NestFastifyApplication;
let appDb: Database;

beforeAll(async () => {
  fx = await createTenancyFixture();
  const url = new URL(fx.db.owner.options.connectionString ?? '');
  url.username = 'app_login';
  url.password = 'app_login';
  appDb = createDatabase(url.toString());

  @Module({ controllers: [TeamsProbeController], providers: [{ provide: 'DB', useValue: appDb }] })
  class ProbeModule {}

  const mod = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterAll(async () => {
  await app?.close();
  await appDb?.close();
  await fx?.stop();
});

it('GET /teams/:id returns 404 across tenants and 200 for the owner', async () => {
  await expectCrossTenantNotFound(app, fx, {
    method: 'GET',
    url: (t) => `/teams/${t.teamId}`,
    authAs: (t) => ({ 'x-test-tenant': t.tenantId }),
  });
});

it('the harness fails loudly when a route leaks across tenants', async () => {
  @Controller('leaky')
  class Leaky {
    @Get(':id')
    get() {
      return { ok: true };
    }
  }
  const mod = await Test.createTestingModule({ controllers: [Leaky] }).compile();
  const leaky = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await leaky.init();
  await leaky.getHttpAdapter().getInstance().ready();
  await expect(
    expectCrossTenantNotFound(leaky, fx, {
      method: 'GET',
      url: (t) => `/leaky/${t.teamId}`,
      authAs: (t) => ({ 'x-test-tenant': t.tenantId }),
    }),
  ).rejects.toThrow(/Tenant A reached tenant B/);
  await leaky.close();
});

it('the harness rejects a vacuous probe (route that 404s for everyone)', async () => {
  await expect(
    expectCrossTenantNotFound(app, fx, {
      method: 'GET',
      url: () => `/teams/${'00000000-0000-4000-8000-000000000000'}`,
      authAs: (t) => ({ 'x-test-tenant': t.tenantId }),
    }),
  ).rejects.toThrow(/vacuous/);
});
