import fs from 'fs';
import path from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import ActivityPanel from '../../frontend/src/components/workspace/ActivityPanel';
import WorkspacePage from '../../frontend/src/pages/WorkspacePage';
import {
  activityReasonKey,
  appendActivityItems,
  buildActivityQuery,
  mergeActivityClientOptions,
  mergeActivityOptions,
} from '../../frontend/src/utils/workspace';
import type { WorkspaceActivityItem } from '../../frontend/src/types';

const readLocale = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), 'locales', `${name}.json`), 'utf8'));
const en = readLocale('en');

const lookup = (tree: any, key: string): string =>
  key.split('.').reduce((node, part) => node?.[part], tree);

jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const plural = options && 'count' in options ? (lookup(en, `${key}_other`) as string) : null;
      return (plural ?? lookup(en, key) ?? key).replace(
        /\{\{(\w+)\}\}/g,
        (_: string, name: string) => String(options?.[name] ?? ''),
      );
    },
  }),
}));
jest.mock('../../frontend/src/services/workspaceService', () => ({
  fetchWorkspaceActivity: jest.fn(),
  fetchWorkspaceClients: jest.fn(),
  fetchWorkspaceServers: jest.fn(),
}));
jest.mock('@/components/workspace/WorkspaceServicesView', () => ({
  __esModule: true,
  default: () => 'SERVICES_VIEW',
}));
jest.mock('@/components/workspace/ConnectedClientsPanel', () => ({
  __esModule: true,
  default: () => 'CLIENTS_PANEL',
}));
jest.mock('@/components/workspace/ActivityPanel', () => ({
  __esModule: true,
  default: () => 'ACTIVITY_PANEL',
}));

const item = (overrides: Partial<WorkspaceActivityItem> = {}): WorkspaceActivityItem => ({
  id: 'a1',
  timestamp: '2026-10-27T10:00:00.000Z',
  server: 'alpha',
  tool: 'ping',
  status: 'success',
  durationMs: 12,
  client: { kind: 'oauth', id: 'c1', name: 'Claude Desktop', active: true },
  ...overrides,
});

// Renders the panel with its state slots preset: items, loading, error, available, nextCursor,
// loadingMore, filters, knownServers, knownClients.
const renderPanel = (state: Partial<Record<string, unknown>> = {}) => {
  const slots = [
    state.items ?? [],
    state.loading ?? false,
    state.error ?? null,
    state.available ?? true,
    state.nextCursor ?? null,
    state.loadingMore ?? false,
    state.filters ?? {},
    state.knownServers ?? [],
    state.knownClients ?? [],
  ];
  // The mocked page module hides the real panel, so load it unmocked for these renders.
  const Real = jest.requireActual<
    typeof import('../../frontend/src/components/workspace/ActivityPanel')
  >('../../frontend/src/components/workspace/ActivityPanel').default;
  const React = jest.requireActual<typeof import('react')>('react');
  let call = 0;
  const spy = jest
    .spyOn(React, 'useState')
    .mockImplementation(() => [slots[call++ % slots.length], jest.fn()] as never);
  try {
    return renderToStaticMarkup(createElement(Real));
  } finally {
    spy.mockRestore();
  }
};

describe('buildActivityQuery', () => {
  it('always carries a limit and leaves out empty filters', () => {
    expect(buildActivityQuery({})).toBe('?limit=25');
  });

  it('turns the filters into query parameters, splitting the client choice', () => {
    const query = new URLSearchParams(
      buildActivityQuery({ server: 'my server', status: 'blocked', client: 'key:id:with:colons' }),
    );
    expect(query.get('server')).toBe('my server');
    expect(query.get('status')).toBe('blocked');
    expect(query.get('clientKind')).toBe('key');
    expect(query.get('clientId')).toBe('id:with:colons');
    expect(query.has('cursor')).toBe(false);
  });

  it('adds the cursor for later pages and never a username', () => {
    const query = new URLSearchParams(buildActivityQuery({ server: 'a' }, 'abc_-', 10));
    expect(query.get('cursor')).toBe('abc_-');
    expect(query.get('limit')).toBe('10');
    expect(buildActivityQuery({ server: 'a' }, 'abc')).not.toContain('username');
  });
});

describe('pagination and options', () => {
  it('appends a page after the rows shown and drops repeats', () => {
    const first = [item({ id: 'a1' }), item({ id: 'a2' })];
    const next = [item({ id: 'a2' }), item({ id: 'a3' })];
    expect(appendActivityItems(first, next).map((row) => row.id)).toEqual(['a1', 'a2', 'a3']);
    expect(appendActivityItems([], next)).toEqual(next);
  });

  it('keeps services sorted and includes ones only the history mentions', () => {
    expect(mergeActivityOptions(['beta'], [item({ server: 'alpha' })], 'zeta')).toEqual([
      'alpha',
      'beta',
      'zeta',
    ]);
  });

  it('lists live clients first, adds departed ones, and fills a missing name', () => {
    const gone = item({ id: 'g', client: { kind: 'key', id: 'k9', name: null, active: false } });
    const options = mergeActivityClientOptions(
      [{ kind: 'oauth', id: 'c1', name: 'Claude Desktop' }],
      [item(), gone],
      'key:k9',
    );
    expect(options).toEqual([
      { value: 'oauth:c1', name: 'Claude Desktop' },
      { value: 'key:k9', name: null },
    ]);
  });

  it('uses status labels for blocked calls and activity reasons for failures', () => {
    expect(activityReasonKey(item())).toBeNull();
    expect(activityReasonKey(item({ status: 'blocked', reason: 'paused' }))).toBe(
      'workspacePage.status.paused',
    );
    expect(activityReasonKey(item({ status: 'error', reason: 'upstream_error' }))).toBe(
      'workspacePage.activity.reason.upstream_error',
    );
  });
});

describe('ActivityPanel states', () => {
  it('lists calls with service, tool, client, result and reason, and filter controls', () => {
    const html = renderPanel({
      items: [
        item(),
        item({ id: 'a2', status: 'error', reason: 'upstream_error', tool: 'boom' }),
        item({ id: 'a3', status: 'blocked', reason: 'maintenance', client: null }),
        item({
          id: 'a4',
          client: { kind: 'key', id: 'k', name: null, active: false },
        }),
        item({
          id: 'a5',
          client: { kind: 'oauth', id: 'o', name: 'Old app', active: false },
        }),
      ],
      knownServers: ['alpha', 'beta'],
    });
    expect(html).toContain('Claude Desktop');
    expect(html).toContain('boom');
    expect(html).toContain('Failed');
    expect(html).toContain('The service returned an error');
    expect(html).toContain('Blocked');
    expect(html).toContain('Maintenance');
    expect(html).toContain('Dashboard or system');
    expect(html).toContain('Unknown client (no longer connected)');
    expect(html).toContain('Old app (no longer connected)');
    expect(html).toContain('12 ms');
    expect(html).toContain('5 events shown');
    expect(html).toContain('All services');
    expect(html).toContain('All results');
    expect(html).toContain('All clients');
    expect(html).toContain('<option value="beta">beta</option>');
    expect(html).not.toContain('Load more');
  });

  it('offers load more only while another page exists, and disables it while loading', () => {
    const rows = [item()];
    expect(renderPanel({ items: rows, nextCursor: 'next' })).toContain('Load more');
    const busy = renderPanel({ items: rows, nextCursor: 'next', loadingMore: true });
    expect(busy).toContain('disabled=""');
    expect(busy).not.toContain('>Load more<');
  });

  it('explains an empty history, and an empty filtered one differently', () => {
    expect(renderPanel()).toContain('No activity yet.');
    const filtered = renderPanel({ filters: { status: 'error' } });
    expect(filtered).toContain('No activity matches these filters.');
  });

  it('explains that history needs database mode, without filters or a table', () => {
    const html = renderPanel({ available: false });
    expect(html).toContain('Activity history needs database mode');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('All services');
  });

  it('shows loading, load failures, and the disabled message', () => {
    expect(renderPanel({ loading: true })).toContain('Loading your workspace');
    expect(renderPanel({ error: { detail: 'HTTP 500', disabled: false } })).toContain(
      'Unable to load activity.',
    );
    const disabled = renderPanel({ error: { detail: '', disabled: true } });
    expect(disabled).toContain('Workspace is no longer available');
  });

  it('never renders payload or error text fields, even if a row carried them', () => {
    const html = renderPanel({
      items: [{ ...item(), errorMessage: 'TOKEN-IN-ERROR', input: 'PRIVATE', output: 'PRIVATE' }],
    });
    expect(html).not.toContain('TOKEN-IN-ERROR');
    expect(html).not.toContain('PRIVATE');
  });
});

describe('WorkspacePage activity tab', () => {
  const page = (url: string) =>
    renderToStaticMarkup(
      createElement(MemoryRouter, { initialEntries: [url] }, createElement(WorkspacePage)),
    );

  it('opens the activity panel from ?tab=activity and marks the tab selected', () => {
    const html = page('/workspace?tab=activity');
    expect(html).toContain('ACTIVITY_PANEL');
    expect(html).not.toContain('SERVICES_VIEW');
    expect(html).toMatch(/aria-selected="true"[^>]*>Activity</);
  });

  it('keeps the other tabs and falls back to services for unknown values', () => {
    expect(page('/workspace?tab=clients')).toContain('CLIENTS_PANEL');
    expect(page('/workspace?tab=bogus')).toContain('SERVICES_VIEW');
    expect(page('/workspace')).toContain('SERVICES_VIEW');
  });
});

describe('activity locale strings', () => {
  const keys = [
    'tab',
    'title',
    'description',
    'empty',
    'emptyFiltered',
    'loadFailed',
    'unavailableTitle',
    'unavailableBody',
    'loadMore',
    'loadingMore',
    'shown_other',
    'columns.time',
    'columns.service',
    'columns.tool',
    'columns.client',
    'columns.result',
    'columns.reason',
    'filters.label',
    'filters.service',
    'filters.result',
    'filters.client',
    'filters.allServices',
    'filters.allResults',
    'filters.allClients',
    'result.success',
    'result.error',
    'result.blocked',
    'reason.tool_error',
    'reason.credential_server_error',
    'reason.unavailable',
    'reason.upstream_error',
    'noClient',
    'unknownClient',
    'clientGone',
    'duration',
  ];

  it.each(['en', 'es', 'fr', 'tr', 'vi', 'zh'])('%s ships every activity string', (locale) => {
    const tree = readLocale(locale).workspacePage.activity;
    for (const key of keys) expect(lookup(tree, key)).toBeTruthy();
    expect(tree.clientGone).toContain('{{name}}');
    expect(tree.duration).toContain('{{ms}}');
  });

  it.each(['en', 'es', 'fr', 'tr'])('%s has a singular form for the shown count', (locale) => {
    const tree = readLocale(locale).workspacePage.activity;
    expect(tree.shown_one).toContain('{{count}}');
    expect(tree.shown_other).toContain('{{count}}');
  });

  it.each(['es', 'fr'])('%s has the many form too', (locale) => {
    expect(readLocale(locale).workspacePage.activity.shown_many).toContain('{{count}}');
  });
});
