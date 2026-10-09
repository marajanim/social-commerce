import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  listConversationsQuery,
  listMessagesQuery,
  sendMessageBody,
  type ConversationPage,
  type ConversationSummary,
  type MessageDto,
  type MessagePage,
  type SendEligibilityDto,
} from '@sc/shared';
import type { z } from 'zod';
import { Auth, RequirePermission, type AuthContext } from '../../common/decorators';
import { ZodBodyPipe } from '../../common/zod-body.pipe';
import { InboxService } from './inbox.service';

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

// Permission scopes (own/team) are not narrowed here yet: assignment arrives with M2-7, and in
// Phase 1 the owner sees every conversation.
@Controller('conversations')
export class InboxController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService) {}

  @RequirePermission('inbox.view')
  @Get()
  list(
    @Auth() auth: AuthContext,
    @Query(new ZodBodyPipe(listConversationsQuery)) q: z.infer<typeof listConversationsQuery>,
  ): Promise<ConversationPage> {
    return this.inbox.list(auth, q);
  }

  @RequirePermission('inbox.view')
  @Get(':id')
  get(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<ConversationSummary> {
    return this.inbox.get(auth, id);
  }

  @RequirePermission('inbox.view')
  @Get(':id/messages')
  messages(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodBodyPipe(listMessagesQuery)) q: z.infer<typeof listMessagesQuery>,
  ): Promise<MessagePage> {
    return this.inbox.messages(auth, id, q);
  }

  @RequirePermission('inbox.view')
  @Get(':id/send-eligibility')
  eligibility(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<SendEligibilityDto> {
    return this.inbox.eligibility(auth, id);
  }

  @RequirePermission('inbox.reply')
  @Post(':id/messages')
  @HttpCode(202)
  send(
    @Auth() auth: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodBodyPipe(sendMessageBody)) body: z.infer<typeof sendMessageBody>,
  ): Promise<MessageDto> {
    if (!key || !IDEMPOTENCY_KEY.test(key)) {
      throw new BadRequestException('An Idempotency-Key header (8 to 100 letters, digits, - or _) is required');
    }
    return this.inbox.send(auth, id, body.body, key);
  }

  @RequirePermission('inbox.view')
  @Post(':id/read')
  @HttpCode(200)
  read(@Auth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<{ lastReadSeq: string }> {
    return this.inbox.markRead(auth, id);
  }
}
