import type { Server as HttpServer } from 'node:http';
import { parse as parseCookie } from 'cookie';
import { Redis } from 'ioredis';
import { Server, type Socket } from 'socket.io';
import { SESSION_COOKIE, type SessionService } from '../modules/auth/session.service';
import type { WorkspacesService } from '../modules/auth/workspaces.service';

export interface RealtimeDeps {
  httpServer: HttpServer;
  sessions: Pick<SessionService, 'validate'>;
  workspaces: Pick<WorkspacesService, 'membership'>;
  redisUrl: string;
  allowedOrigin: string;
}

const CHANNEL = /^t:([0-9a-f-]{36}):events$/;

/**
 * Pushes committed events to the right browsers. The handshake uses the same session cookie as the
 * REST API; each socket joins exactly one room, its workspace's, so it can only ever receive that
 * tenant's events. The tenant for a published event is taken from the Redis channel name that the
 * outbox publisher wrote, never from the event body. There are no client-to-server events, so there
 * are no handlers that would need a permission check.
 */
export async function attachRealtime(deps: RealtimeDeps): Promise<{ io: Server; close(): Promise<void> }> {
  const io = new Server(deps.httpServer, {
    cors: { origin: deps.allowedOrigin, credentials: true },
    serveClient: false,
  });

  io.use(async (socket: Socket, next) => {
    try {
      const cookies = parseCookie(socket.handshake.headers.cookie ?? '');
      const token = cookies[SESSION_COOKIE];
      if (!token) return next(new Error('unauthorized'));
      const session = await deps.sessions.validate(token);
      if (!session?.tenantId) return next(new Error('unauthorized'));
      const membership = await deps.workspaces.membership(session.userId, session.tenantId);
      if (!membership?.permissions.has('inbox.view')) return next(new Error('unauthorized'));
      socket.data = { tenantId: session.tenantId, userId: session.userId };
      return next();
    } catch {
      return next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { tenantId } = socket.data as { tenantId: string };
    void socket.join(`t:${tenantId}`);
  });

  const sub = new Redis(deps.redisUrl);
  await sub.psubscribe('t:*:events');
  sub.on('pmessage', (_pattern, channel, message) => {
    const tenantId = CHANNEL.exec(channel)?.[1];
    if (!tenantId) return;
    try {
      io.to(`t:${tenantId}`).emit('event', JSON.parse(message));
    } catch {
      // a malformed message must not take the gateway down
    }
  });

  return {
    io,
    async close() {
      await sub.quit().catch(() => undefined);
      await io.close();
    },
  };
}
