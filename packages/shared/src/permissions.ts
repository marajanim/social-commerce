// Permission keys and the built-in role matrix (docs/specs/feature-specs.md, Roles).
// Add a key here AND to ROLE_PERMISSIONS; the seed writes both to the database.

export type PermissionScope = 'own' | 'team' | 'all';

export const PERMISSIONS = {
  'account.self': { module: 'account', description: 'View and manage your own session and profile' },
  'inbox.view': { module: 'inbox', description: 'View conversations' },
  'inbox.reply': { module: 'inbox', description: 'Reply to customers' },
  'inbox.note': { module: 'inbox', description: 'Write internal notes' },
  'inbox.assign': { module: 'inbox', description: 'Assign or reassign conversations' },
  'inbox.takeover': { module: 'inbox', description: 'Take a conversation over from the AI' },
  'inbox.labels': { module: 'inbox', description: 'Manage labels and saved replies' },
  'inbox.export': { module: 'inbox', description: 'Export conversations' },
  'channels.view': { module: 'channels', description: 'View channel health' },
  'channels.manage': { module: 'channels', description: 'Connect, reconnect or remove channels' },
  'catalog.view': { module: 'catalog', description: 'View products and stock' },
  'catalog.manage': { module: 'catalog', description: 'Create and edit products, stock and delivery settings' },
  'orders.view': { module: 'orders', description: 'View orders' },
  'orders.manage': { module: 'orders', description: 'Confirm, pack, ship and cancel orders' },
  'ai.view': { module: 'ai', description: 'View AI agent settings and runs' },
  'ai.manage': { module: 'ai', description: 'Change AI mode, persona and policies' },
  'members.view': { module: 'settings', description: 'View team members' },
  'members.manage': { module: 'settings', description: 'Invite members and change roles' },
  'analytics.view': { module: 'analytics', description: 'View analytics' },
  'audit.view': { module: 'settings', description: 'View the audit log' },
  'billing.manage': { module: 'billing', description: 'Manage plan, payment and invoices' },
  'workspace.manage': { module: 'settings', description: 'Edit workspace settings' },
  'workspace.delete': { module: 'settings', description: 'Delete the workspace or transfer ownership' },
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export const ROLE_KEYS = ['owner', 'admin', 'supervisor', 'agent', 'order_manager', 'analyst'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_NAMES: Record<RoleKey, string> = {
  owner: 'Owner',
  admin: 'Admin',
  supervisor: 'Supervisor',
  agent: 'Agent',
  order_manager: 'Order manager',
  analyst: 'Analyst',
};

type Grants = Partial<Record<PermissionKey, PermissionScope>>;

const all = (keys: PermissionKey[]): Grants => Object.fromEntries(keys.map((k) => [k, 'all'])) as Grants;

export const ROLE_PERMISSIONS: Record<RoleKey, Grants> = {
  owner: all(PERMISSION_KEYS),
  admin: all(PERMISSION_KEYS.filter((k) => k !== 'workspace.delete')),
  supervisor: all([
    'account.self',
    'inbox.view',
    'inbox.reply',
    'inbox.note',
    'inbox.assign',
    'inbox.takeover',
    'inbox.labels',
    'channels.view',
    'catalog.view',
    'orders.view',
    'ai.view',
    'members.view',
    'analytics.view',
  ]),
  agent: {
    'account.self': 'all',
    'inbox.view': 'team',
    'inbox.reply': 'own',
    'inbox.note': 'all',
    'inbox.assign': 'own',
    'inbox.takeover': 'all',
    'inbox.labels': 'own',
    'channels.view': 'all',
    'catalog.view': 'all',
    'orders.view': 'own',
  },
  order_manager: {
    'account.self': 'all',
    'inbox.view': 'own',
    'inbox.note': 'all',
    'catalog.view': 'all',
    'orders.view': 'all',
    'orders.manage': 'all',
  },
  analyst: { 'account.self': 'all', 'analytics.view': 'all' },
};
