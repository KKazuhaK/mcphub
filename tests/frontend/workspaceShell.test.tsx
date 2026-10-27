import fs from 'fs';
import path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import RouteAccessGuard from '../../frontend/src/components/RouteAccessGuard';
import Sidebar from '../../frontend/src/components/layout/Sidebar';

let mockAuthUser: { username: string; isAdmin: boolean } = { username: 'alice', isAdmin: false };
let mockSettings = {
  workspaceEnabled: true,
  workspaceResolved: true,
  workspaceLoadFailed: false,
  fetchSettings: jest.fn(),
};

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
jest.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ auth: { user: mockAuthUser, loading: false, isAuthenticated: true } }),
}));
jest.mock('@/contexts/SettingsContext', () => ({ useSettings: () => mockSettings }));
jest.mock('@/contexts/ServerContext', () => ({ useServerContext: () => ({ allServers: [] }) }));
jest.mock('@/hooks/useGroupData', () => ({ useGroupData: () => ({ groups: [] }) }));
jest.mock('@/services/activityService', () => ({
  checkActivityAvailable: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('@/utils/appVersion', () => ({ APP_VERSION: 'test' }));
jest.mock('@/components/ui/UserProfileMenu', () => ({ __esModule: true, default: () => null }));
jest.mock('../../frontend/src/components/PermissionChecker', () => ({
  usePermissionCheck: () => true,
}));

const renderSidebar = () =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(Sidebar, { collapsed: false })),
  );

const renderGuard = (pathname: string) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [pathname] },
      createElement(
        Routes,
        null,
        createElement(
          Route,
          { element: createElement(RouteAccessGuard) },
          createElement(Route, { path: '/', element: 'DASHBOARD-PAGE' }),
          createElement(Route, { path: '/users', element: 'USERS-PAGE' }),
          createElement(Route, { path: '/workspace', element: 'WORKSPACE-PAGE' }),
        ),
      ),
    ),
  );

const setSettings = (user: typeof mockAuthUser, settings: Partial<typeof mockSettings>) => {
  mockAuthUser = user;
  mockSettings = { ...mockSettings, ...settings };
};
const alice = { username: 'alice', isAdmin: false };
const admin = { username: 'admin', isAdmin: true };
const ready = { workspaceEnabled: true, workspaceResolved: true, workspaceLoadFailed: false };

describe('Sidebar', () => {
  it('shows an ordinary user only workspace, credentials and settings in workspace mode', () => {
    setSettings(alice, ready);
    const html = renderSidebar();
    expect(html).toContain('workspacePage.nav');
    expect(html).toContain('credentials.title');
    expect(html).toContain('nav.settings');
    for (const hidden of ['nav.dashboard', 'nav.servers', 'nav.groups', 'nav.prompts', 'nav.resources', 'nav.market']) {
      expect(html).not.toContain(hidden);
    }
  });

  it('renders no admin entries for an ordinary user until the setting is known', () => {
    setSettings(alice, { workspaceEnabled: false, workspaceResolved: false });
    const html = renderSidebar();
    expect(html).not.toContain('nav.servers');
    expect(html).not.toContain('nav.dashboard');
  });

  it('falls back to the normal navigation when the settings read failed', () => {
    setSettings(alice, { workspaceEnabled: false, workspaceResolved: true, workspaceLoadFailed: true });
    const html = renderSidebar();
    expect(html).toContain('nav.servers');
    expect(html).toContain('nav.dashboard');
    expect(html).not.toContain('workspacePage.nav');
  });

  it('gives admins everything plus the workspace entry', () => {
    setSettings(admin, ready);
    const html = renderSidebar();
    for (const shown of ['workspacePage.nav', 'nav.dashboard', 'nav.servers', 'nav.market']) {
      expect(html).toContain(shown);
    }
  });
});

describe('RouteAccessGuard', () => {
  it('shows the loading state until the setting is resolved', () => {
    setSettings(alice, { workspaceEnabled: false, workspaceResolved: false, workspaceLoadFailed: false });
    const html = renderGuard('/');
    expect(html).toContain('app.loading');
    expect(html).not.toContain('DASHBOARD-PAGE');
  });

  it('treats a failed settings read as workspace off and offers a retry', () => {
    setSettings(alice, { workspaceEnabled: false, workspaceResolved: true, workspaceLoadFailed: true });
    const html = renderGuard('/users');
    expect(html).toContain('USERS-PAGE');
    expect(html).not.toContain('app.loading');
    expect(html).toContain('role="alert"');
    expect(html).toContain('workspacePage.settingsFailed');
    expect(html).toContain('workspacePage.retry');
  });

  it('keeps ordinary users out of admin pages in workspace mode', () => {
    setSettings(alice, ready);
    expect(renderGuard('/users')).not.toContain('USERS-PAGE');
    expect(renderGuard('/workspace')).toContain('WORKSPACE-PAGE');
  });
});

describe('App routes', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'frontend', 'src', 'App.tsx'),
    'utf8',
  );
  it('makes the access guard the only child of the main layout route', () => {
    expect(source).toMatch(
      /<Route element=\{<MainLayout \/>\}>\s*<Route element=\{<RouteAccessGuard \/>\}>/,
    );
    // After the guard's routes come exactly the guard, layout and protected-route closers.
    expect(source).toMatch(
      /<Route path="\/settings" element=\{<SettingsPage \/>\} \/>\s*<\/Route>\s*<\/Route>\s*<\/Route>/,
    );
  });

  it('keeps every page route inside the layout', () => {
    const layout = source.slice(source.indexOf('<MainLayout />'), source.indexOf('path="*"'));
    const pagePaths = [...layout.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]);
    expect(pagePaths).toEqual(
      expect.arrayContaining([
        '/',
        '/workspace',
        '/credentials',
        '/servers',
        '/users',
        '/logs',
        '/activity',
        '/settings',
      ]),
    );
  });
});
