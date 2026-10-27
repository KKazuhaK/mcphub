type UserLike = {
  isAdmin?: boolean;
} | null | undefined;

export const canViewSystemLogs = (user: UserLike): boolean => Boolean(user?.isAdmin);

export type NavContext = {
  isAdmin: boolean;
  workspaceEnabled: boolean;
  // False until the Workspace Mode setting has been read; defaults to true.
  resolved?: boolean;
};

// Pages that stay admin-only for ordinary users once Workspace Mode is on.
// Every page in App.tsx except the workspace, credentials and settings pages.
export const ADMIN_ONLY_IN_WORKSPACE = [
  '/servers',
  '/groups',
  '/prompts',
  '/resources',
  '/market',
  '/cloud',
  '/users',
  '/logs',
  '/activity',
];

const matchesPrefix = (pathname: string, prefix: string): boolean =>
  pathname === prefix || pathname.startsWith(`${prefix}/`);

/** Where `/` leads: ordinary users land on the workspace page when the mode is on. */
export const isDashboardHome = (ctx: NavContext): boolean =>
  ctx.isAdmin || !ctx.workspaceEnabled;

/** Whether the path may be shown to the user. Workspace Mode off leaves every route as before. */
export const isRouteAllowed = (pathname: string, ctx: NavContext): boolean => {
  if (pathname === '/workspace' || pathname.startsWith('/workspace/')) return ctx.workspaceEnabled;
  if (!ctx.workspaceEnabled || ctx.isAdmin) return true;
  if (pathname === '/') return false;
  return !ADMIN_ONLY_IN_WORKSPACE.some((prefix) => matchesPrefix(pathname, prefix));
};

/** Where a user is sent when a path is not allowed for them. */
export const fallbackPath = (ctx: NavContext): string =>
  ctx.workspaceEnabled && !ctx.isAdmin ? '/workspace' : '/';

export type NavKey =
  | 'workspace'
  | 'dashboard'
  | 'servers'
  | 'groups'
  | 'prompts'
  | 'resources'
  | 'market';

const WORKSPACE_GROUP_ITEMS: readonly NavKey[] = [
  'dashboard',
  'servers',
  'groups',
  'prompts',
  'resources',
  'market',
];

/** Entries of the sidebar's first section, in order. Credentials/Settings/admin pages are separate. */
export const getWorkspaceNavKeys = (ctx: NavContext): NavKey[] => {
  // Until the setting is known an ordinary user gets no entries, so admin pages never flash.
  if (ctx.resolved === false && !ctx.isAdmin) return [];
  if (!ctx.workspaceEnabled) return [...WORKSPACE_GROUP_ITEMS];
  return ctx.isAdmin ? ['workspace', ...WORKSPACE_GROUP_ITEMS] : ['workspace'];
};
