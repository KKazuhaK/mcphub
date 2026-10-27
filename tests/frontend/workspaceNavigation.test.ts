import {
  ADMIN_ONLY_IN_WORKSPACE,
  fallbackPath,
  getWorkspaceNavKeys,
  isDashboardHome,
  isRouteAllowed,
} from '../../frontend/src/utils/navigationPermissions';

const adminOn = { isAdmin: true, workspaceEnabled: true };
const userOn = { isAdmin: false, workspaceEnabled: true };
const adminOff = { isAdmin: true, workspaceEnabled: false };
const userOff = { isAdmin: false, workspaceEnabled: false };

describe('workspace navigation entries', () => {
  it('leaves the sidebar unchanged when workspace mode is off', () => {
    const all = ['dashboard', 'servers', 'groups', 'prompts', 'resources', 'market'];
    expect(getWorkspaceNavKeys(adminOff)).toEqual(all);
    expect(getWorkspaceNavKeys(userOff)).toEqual(all);
  });

  it('shows ordinary users only the workspace entry when the mode is on', () => {
    expect(getWorkspaceNavKeys(userOn)).toEqual(['workspace']);
  });

  it('renders no entries for an ordinary user until the setting is resolved', () => {
    expect(getWorkspaceNavKeys({ ...userOn, resolved: false })).toEqual([]);
    expect(getWorkspaceNavKeys({ ...userOff, resolved: false })).toEqual([]);
    expect(getWorkspaceNavKeys({ ...adminOn, resolved: false })).toContain('workspace');
  });

  it('gives admins a workspace entry in addition to everything else', () => {
    expect(getWorkspaceNavKeys(adminOn)).toEqual([
      'workspace',
      'dashboard',
      'servers',
      'groups',
      'prompts',
      'resources',
      'market',
    ]);
  });
});

describe('workspace route access', () => {
  const adminPages = [
    '/',
    '/servers',
    '/groups',
    '/prompts',
    '/resources',
    '/market',
    '/market/foo',
    '/cloud',
    '/cloud/foo',
    '/users',
    '/logs',
    '/activity',
  ];
  const personalPages = ['/workspace', '/workspace/clients', '/credentials', '/settings'];

  it.each(adminPages)('redirects ordinary users away from %s when the mode is on', (path) => {
    expect(isRouteAllowed(path, userOn)).toBe(false);
  });

  it.each([...adminPages, ...personalPages])('lets admins open %s when the mode is on', (path) => {
    expect(isRouteAllowed(path, adminOn)).toBe(true);
  });

  it.each(personalPages)('lets ordinary users open %s when the mode is on', (path) => {
    expect(isRouteAllowed(path, userOn)).toBe(true);
  });

  it.each([...adminPages, '/credentials', '/settings'])(
    'allows %s for everyone when the mode is off',
    (path) => {
      expect(isRouteAllowed(path, adminOff)).toBe(true);
      expect(isRouteAllowed(path, userOff)).toBe(true);
    },
  );

  it('hides the workspace pages when the mode is off', () => {
    expect(isRouteAllowed('/workspace', adminOff)).toBe(false);
    expect(isRouteAllowed('/workspace/clients', userOff)).toBe(false);
  });

  it('sends ordinary users to the workspace and everyone else to the dashboard', () => {
    expect(fallbackPath(userOn)).toBe('/workspace');
    expect(fallbackPath(adminOn)).toBe('/');
    expect(fallbackPath(userOff)).toBe('/');
    expect(isDashboardHome(userOn)).toBe(false);
    expect(isDashboardHome(adminOn)).toBe(true);
    expect(isDashboardHome(userOff)).toBe(true);
  });
});

describe('admin-only route list', () => {
  it('covers every admin-style page of the app', () => {
    expect(ADMIN_ONLY_IN_WORKSPACE).toEqual(
      expect.arrayContaining(['/users', '/logs', '/activity', '/cloud', '/market', '/servers']),
    );
  });
});
