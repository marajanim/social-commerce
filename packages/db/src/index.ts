export { createDatabase, createAuthDatabase, type Database } from './client';
export { createTenantDb, createUserDb, type TenantContext, type TenantDb, type Tx } from './tenant-db';
export { createAuthDb, type AuthDb, type AuthTx } from './auth-db';
export { migrate, MIGRATIONS_DIR } from './migrate';
export { ensureLoginRoles, type LoginPasswords } from './logins';
export { seedPermissionCatalog, createWorkspaceWithOwner, addMember, type NewWorkspace } from './seed';
export * as schema from './schema';
