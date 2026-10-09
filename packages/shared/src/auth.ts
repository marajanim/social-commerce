import { z } from 'zod';

// Request bodies for the auth endpoints, shared by the API (validation) and the web app (forms).
const email = z.string().trim().toLowerCase().email().max(254);
export const passwordRule = z.string().min(10, 'at least 10 characters').max(200);

export const loginBody = z.object({ email, password: z.string().min(1).max(200) });
export const forgotPasswordBody = z.object({ email });
export const resetPasswordBody = z.object({ token: z.string().min(20).max(200), password: passwordRule });
export const verifyEmailBody = z.object({ token: z.string().min(20).max(200) });
export const switchWorkspaceBody = z.object({ tenantId: z.string().uuid() });

export type LoginBody = z.infer<typeof loginBody>;

export interface WorkspaceSummary {
  tenantId: string;
  name: string;
  roleKey: string;
}

/** Shape of GET /me. The UI hides what `permissions` does not allow; the server enforces it anyway. */
export interface MeResponse {
  user: { id: string; email: string; name: string; locale: string; emailVerified: boolean };
  workspace: { tenantId: string; name: string; timezone: string; roleKey: string };
  workspaces: WorkspaceSummary[];
  permissions: Record<string, 'own' | 'team' | 'all'>;
}
