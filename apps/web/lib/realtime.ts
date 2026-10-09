'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

export interface RealtimeEvent {
  id: string;
  type: string;
  tenantId: string;
  aggregateId: string;
  payload: { conversationId?: string; messageIds?: string[]; status?: string; [k: string]: unknown };
}

const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? 'http://localhost:4003';

/**
 * Subscribes to this workspace's live events. `onEvent` always sees the latest closure.
 * `onReconnect` fires when the socket comes back after a drop: refetch what you show, because
 * events published while disconnected are not replayed.
 */
export function useRealtime(handlers: { onEvent: (e: RealtimeEvent) => void; onReconnect: () => void }) {
  const [connected, setConnected] = useState(false);
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    // The session cookie is host-scoped (not port-scoped), so it is sent to the gateway too.
    const socket: Socket = io(REALTIME_URL, { withCredentials: true, transports: ['websocket', 'polling'] });
    let everConnected = false;
    socket.on('connect', () => {
      setConnected(true);
      if (everConnected) ref.current.onReconnect();
      everConnected = true;
    });
    socket.on('disconnect', () => setConnected(false));
    socket.on('event', (e: RealtimeEvent) => ref.current.onEvent(e));
    return () => {
      socket.close();
    };
  }, []);

  return { connected };
}
