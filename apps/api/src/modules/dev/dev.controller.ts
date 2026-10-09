import { Body, Controller, HttpCode, Inject, NotFoundException, Post } from '@nestjs/common';
import { schema, type Database } from '@sc/db';
import { ingestInboundMessage } from '@sc/inbox';
import { simulateMessageBody } from '@sc/shared';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../../common/decorators';
import { ZodBodyPipe } from '../../common/zod-body.pipe';
import { CONFIG, type Config } from '../../config';
import { DATABASE } from '../../db/db.module';

/**
 * Development helper: injects a customer message through the same ingest path the webhook worker
 * uses, so the inbox can be tried without a Meta app. Answers 404 unless ENABLE_DEV_SIMULATOR is
 * on, and is always off in production.
 */
@Controller('dev')
export class DevController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @RequirePermission('channels.manage')
  @Post('simulate-message')
  @HttpCode(200)
  async simulate(
    @Auth() auth: AuthContext,
    @Body(new ZodBodyPipe(simulateMessageBody)) body: z.infer<typeof simulateMessageBody>,
  ): Promise<{ conversationId: string }> {
    if (!this.config.simulatorEnabled) throw new NotFoundException();
    const customerId = `sim-${body.customerName.toLowerCase().replace(/[^a-z0-9ঀ-৿]+/g, '-').slice(0, 40)}`;
    const result = await this.db.tenantDb({ tenantId: auth.tenantId, userId: auth.userId }).transaction(async (tx) => {
      const account = (
        await tx
          .select({ id: schema.channelAccounts.id, channelKey: schema.channelAccounts.channelKey, externalId: schema.channelAccounts.externalId })
          .from(schema.channelAccounts)
          .where(and(eq(schema.channelAccounts.tenantId, auth.tenantId), eq(schema.channelAccounts.id, body.channelAccountId)))
      )[0];
      if (!account) throw new NotFoundException('Channel not found');
      return ingestInboundMessage(tx, {
        tenantId: auth.tenantId,
        account: { id: account.id, channelKey: account.channelKey },
        profile: { name: body.customerName, picUrl: null },
        event: {
          kind: 'message',
          externalAccountId: account.externalId,
          externalUserId: customerId,
          providerMessageId: `sim_${randomUUID()}`,
          timestamp: new Date(),
          contentType: 'text',
          body: body.text,
          attachments: [],
          isEcho: false,
        },
      });
    });
    return { conversationId: result.conversationId as string };
  }
}
