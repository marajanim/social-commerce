'use client';

import type { MeResponse } from '@sc/shared';
import { createContext, useContext, type ReactNode } from 'react';

const MeContext = createContext<MeResponse | null>(null);

export function MeProvider({ me, children }: { me: MeResponse; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe must be used inside <MeProvider>');
  return me;
}

export const can = (me: MeResponse, permission: string) => permission in me.permissions;
