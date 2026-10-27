import type {
  WorkspaceServer,
  WorkspaceStatusAction,
  WorkspaceStatusCode,
  WorkspaceSummary,
} from '../../frontend/src/types';
import {
  TOOL_COUNT_STRONG,
  TOOL_COUNT_WARN,
  applySelection,
  buildSmartEndpoint,
  buildWorkspaceSnippets,
  createLatestOnly,
  isHttpUrl,
  pruneAuthLinks,
  isWorkspaceDisabledMessage,
  localizeStatusMessage,
  resolveOAuthLaunch,
  resolveWorkspaceSetting,
  shouldRefreshOnFocus,
  countExposedTools,
  credentialsPath,
  resolveServiceAction,
  resolveSummaryBanner,
  toggleServerSelection,
  toolCountLevel,
} from '../../frontend/src/utils/workspace';

const server = (
  name: string,
  code: WorkspaceStatusCode,
  action: WorkspaceStatusAction,
  extra: Partial<WorkspaceServer> = {},
): WorkspaceServer => ({
  name,
  selected: code !== 'not_selected',
  enabled: true,
  toolCount: 5,
  requiresPersonalCredential: false,
  credentialConfigured: true,
  status: { code, message: `${name} ${code}`, action },
  ...extra,
});

describe('tool count thresholds', () => {
  it('warns above 40 and strongly above 80', () => {
    expect(TOOL_COUNT_WARN).toBe(40);
    expect(TOOL_COUNT_STRONG).toBe(80);
    expect(toolCountLevel(0)).toBe('ok');
    expect(toolCountLevel(40)).toBe('ok');
    expect(toolCountLevel(41)).toBe('warn');
    expect(toolCountLevel(80)).toBe('warn');
    expect(toolCountLevel(81)).toBe('strong');
  });

  it('counts tools of selected, available services only', () => {
    const servers = [
      server('a', 'available', null, { toolCount: 10 }),
      server('b', 'needs_auth', 'connect', { toolCount: 30 }),
      server('c', 'not_selected', 'select', { toolCount: 50, selected: false }),
      server('d', 'available', null, { toolCount: 7 }),
    ];
    expect(countExposedTools(servers)).toBe(17);
  });
});

describe('action mapping per status code', () => {
  const credentialServers = new Set(['slots']);

  it.each([
    ['available', null, { kind: 'none' }],
    ['not_selected', 'select', { kind: 'select' }],
    ['paused', 'contact_admin', { kind: 'contact_admin' }],
    ['maintenance', 'retry_later', { kind: 'retry_later', until: undefined }],
    ['error', 'retry_later', { kind: 'retry_later', until: undefined }],
  ] as const)('%s -> %p', (code, action, expected) => {
    expect(resolveServiceAction(server('s', code, action), credentialServers)).toEqual(expected);
  });

  it('passes the maintenance end time through', () => {
    const s = server('s', 'maintenance', 'retry_later');
    s.status.until = '2026-11-01T00:00:00.000Z';
    expect(resolveServiceAction(s, credentialServers)).toEqual({
      kind: 'retry_later',
      until: '2026-11-01T00:00:00.000Z',
    });
  });

  it('routes connect to the credentials page for servers with credential slots', () => {
    for (const code of ['needs_auth', 'credential_invalid'] as const) {
      expect(resolveServiceAction(server('slots', code, 'connect'), credentialServers)).toEqual({
        kind: 'credentials',
        server: 'slots',
      });
    }
  });

  it('routes connect to personal OAuth for servers without credential slots', () => {
    for (const code of ['needs_auth', 'revoked', 'credential_invalid'] as const) {
      expect(resolveServiceAction(server('gitlab', code, 'connect'), credentialServers)).toEqual({
        kind: 'oauth',
        server: 'gitlab',
      });
    }
  });

  it('reconnects a disconnected personal OAuth through OAuth even if slots exist', () => {
    expect(resolveServiceAction(server('slots', 'revoked', 'connect'), credentialServers)).toEqual({
      kind: 'oauth',
      server: 'slots',
    });
  });

  it('falls back to the credentials page when the slot list is unknown', () => {
    expect(resolveServiceAction(server('x', 'needs_auth', 'connect'), null)).toEqual({
      kind: 'credentials',
      server: 'x',
    });
  });

  it('honours an overridden action such as contact_admin on needs_auth', () => {
    expect(
      resolveServiceAction(server('x', 'needs_auth', 'contact_admin'), credentialServers),
    ).toEqual({ kind: 'contact_admin' });
  });

  it('builds a credentials deep link the Credentials page understands', () => {
    expect(credentialsPath('my server')).toBe('/credentials?server=my%20server');
  });
});

describe('summary banner', () => {
  const summary = (
    endpointState: WorkspaceSummary['endpointState'],
    counts: Partial<WorkspaceSummary['counts']>,
  ): WorkspaceSummary => ({
    endpointState,
    counts: {
      available: 0,
      not_selected: 0,
      paused: 0,
      maintenance: 0,
      needs_auth: 0,
      revoked: 0,
      credential_invalid: 0,
      error: 0,
      ...counts,
    },
  });

  it('reports normal, partial and empty states', () => {
    expect(resolveSummaryBanner(summary('normal', { available: 3 }))).toEqual({
      kind: 'normal',
      selected: 3,
      attention: 0,
    });
    expect(
      resolveSummaryBanner(summary('partial', { available: 3, needs_auth: 1, error: 1 })),
    ).toEqual({ kind: 'partial', selected: 5, attention: 2 });
    expect(resolveSummaryBanner(summary('empty', { not_selected: 4 })).kind).toBe('none_selected');
    expect(resolveSummaryBanner(summary('empty', { paused: 2 })).kind).toBe('none_usable');
  });
});

describe('optimistic selection', () => {
  const initial = [server('a', 'available', null), server('b', 'not_selected', 'select')];

  it('applies the change before the save finishes', async () => {
    let state = initial;
    let release!: () => void;
    const save = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const done = toggleServerSelection('b', true, {
      save,
      update: (updater) => {
        state = updater(state);
      },
    });
    expect(state.find((s) => s.name === 'b')?.selected).toBe(true);
    release();
    await expect(done).resolves.toBe(true);
    expect(save).toHaveBeenCalledWith('b', true);
    expect(state.find((s) => s.name === 'b')?.selected).toBe(true);
  });

  it('rolls back only the toggled row when saving fails', async () => {
    let state = initial;
    const result = await toggleServerSelection('a', false, {
      save: async () => {
        // Another row changes while the request is in flight.
        state = applySelection(state, 'b', true);
        throw new Error('boom');
      },
      update: (updater) => {
        state = updater(state);
      },
    });
    expect(result).toBe(false);
    expect(state.find((s) => s.name === 'a')?.selected).toBe(true);
    expect(state.find((s) => s.name === 'b')?.selected).toBe(true);
  });
});

describe('endpoints and snippets', () => {
  const aggregate = 'https://hub.example.com/alice/mcp';

  it('appends the smart routing segment to the personal endpoint', () => {
    expect(buildSmartEndpoint(aggregate)).toBe('https://hub.example.com/alice/mcp/$smart');
    expect(buildSmartEndpoint(`${aggregate}/`, 'smart')).toBe(
      'https://hub.example.com/alice/mcp/smart',
    );
  });

  it('builds URL-only snippets without credentials', () => {
    const generic = buildWorkspaceSnippets('generic-mcp-servers', aggregate)[0].text;
    expect(JSON.parse(generic)).toEqual({ mcpServers: { mcphub: { url: aggregate } } });

    const claude = buildWorkspaceSnippets('claude-code', aggregate).map((block) => block.text);
    expect(claude.join('\n')).toContain(aggregate);
    expect(claude.join('\n')).not.toMatch(/Authorization|Bearer/i);

    expect(buildWorkspaceSnippets('cursor', aggregate)[0].text).toContain(aggregate);
  });
});

describe('latest-only loading', () => {
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  it('ignores a slow stale response that finishes after a newer one', async () => {
    const gate = createLatestOnly();
    const first = deferred<string>();
    const second = deferred<string>();
    const applied: string[] = [];
    const a = gate.run(() => first.promise, (value) => applied.push(value));
    const b = gate.run(() => second.promise, (value) => applied.push(value));
    second.resolve('new');
    await expect(b).resolves.toBe(true);
    first.resolve('stale');
    await expect(a).resolves.toBe(false);
    expect(applied).toEqual(['new']);
  });

  it('drops loads in flight when invalidated', async () => {
    const gate = createLatestOnly();
    const pending = deferred<string>();
    const applied: string[] = [];
    const run = gate.run(() => pending.promise, (value) => applied.push(value));
    gate.invalidate();
    pending.resolve('stale');
    await run;
    expect(applied).toEqual([]);
  });

  it('skips focus refreshes while a selection save is in flight', () => {
    expect(shouldRefreshOnFocus(0)).toBe(true);
    expect(shouldRefreshOnFocus(1)).toBe(false);
  });
});

describe('authorization launch', () => {
  it('only accepts http(s) URLs', () => {
    expect(isHttpUrl('https://idp.example.com/authorize?x=1')).toBe(true);
    expect(isHttpUrl('http://localhost:3000/a')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,hi')).toBe(false);
    expect(isHttpUrl('not a url')).toBe(false);
    expect(isHttpUrl(undefined)).toBe(false);
  });

  it('navigates the popup, falls back to a link when it was blocked, rejects bad URLs', () => {
    expect(resolveOAuthLaunch('https://idp.example.com/a', true)).toEqual({
      kind: 'navigate',
      url: 'https://idp.example.com/a',
    });
    expect(resolveOAuthLaunch('https://idp.example.com/a', false)).toEqual({
      kind: 'link',
      url: 'https://idp.example.com/a',
    });
    expect(resolveOAuthLaunch('javascript:alert(1)', true)).toEqual({ kind: 'invalid' });
    expect(resolveOAuthLaunch(undefined, true)).toEqual({ kind: 'none' });
  });
});

describe('workspace error handling helpers', () => {
  it('recognises the answer given once workspace mode is off', () => {
    expect(isWorkspaceDisabledMessage('Not found')).toBe(true);
    expect(isWorkspaceDisabledMessage('HTTP 404: Not Found')).toBe(true);
    expect(isWorkspaceDisabledMessage('Unable to list workspace servers')).toBe(false);
    expect(isWorkspaceDisabledMessage(undefined)).toBe(false);
  });

  it('treats a failed settings read as workspace mode off', () => {
    expect(resolveWorkspaceSetting({ success: false })).toEqual({ enabled: false, failed: true, signedOut: false });
    expect(resolveWorkspaceSetting(undefined)).toEqual({ enabled: false, failed: true, signedOut: false });
    expect(
      resolveWorkspaceSetting({ success: true, data: { systemConfig: { workspace: { enabled: true } } } }),
    ).toEqual({ enabled: true, failed: false, signedOut: false });
    expect(resolveWorkspaceSetting({ success: true, data: { systemConfig: {} } })).toEqual({
      enabled: false,
      failed: false,
      signedOut: false,
    });
  });

  it('shows the maintenance end time localized instead of as an ISO instant', () => {
    const until = '2026-11-01T00:00:00.000Z';
    const text = localizeStatusMessage(
      { message: `'x' is under maintenance until ${until}. Try again later. Back soon.`, until },
      () => '1 Nov 2026',
    );
    expect(text).toBe("'x' is under maintenance until 1 Nov 2026. Try again later. Back soon.");
    expect(localizeStatusMessage({ message: 'plain' }, () => 'unused')).toBe('plain');
  });
});

describe('summary banner source of truth', () => {
  it('follows the backend endpoint state even when the counts disagree', () => {
    const counts = {
      available: 0,
      not_selected: 0,
      paused: 0,
      maintenance: 0,
      needs_auth: 0,
      revoked: 0,
      credential_invalid: 0,
      error: 0,
    };
    expect(resolveSummaryBanner({ endpointState: 'normal', counts: { ...counts, error: 2 } }).kind).toBe('normal');
    expect(resolveSummaryBanner({ endpointState: 'partial', counts }).kind).toBe('partial');
  });
});

describe('settings read after a known value', () => {
  it('keeps the last known workspace setting when a later read fails', () => {
    expect(resolveWorkspaceSetting({ success: false, status: 500 }, true)).toEqual({
      enabled: true,
      failed: true,
      signedOut: false,
    });
    expect(resolveWorkspaceSetting(undefined, false)).toEqual({
      enabled: false,
      failed: true,
      signedOut: false,
    });
  });

  it('reads a 401 as a signed-out session, not a failed read', () => {
    expect(resolveWorkspaceSetting({ success: false, status: 401 }, true)).toEqual({
      enabled: true,
      failed: false,
      signedOut: true,
    });
  });
});

describe('superseded runs', () => {
  it('does not surface the error of a run that was superseded', async () => {
    const gate = createLatestOnly();
    let fail!: (error: Error) => void;
    const slow = new Promise<string>((_, reject) => {
      fail = reject;
    });
    const stale = gate.run(() => slow, () => undefined);
    await gate.run(async () => 'fresh', () => undefined);
    fail(new Error('late failure'));
    await expect(stale).resolves.toBe(false);
  });

  it('still surfaces the error of the newest run', async () => {
    const gate = createLatestOnly();
    await expect(
      gate.run(
        async () => {
          throw new Error('boom');
        },
        () => undefined,
      ),
    ).rejects.toThrow('boom');
  });
});

describe('authorization links', () => {
  const needs = server('a', 'needs_auth', 'connect');
  it('keeps links only for servers that still need sign-in', () => {
    const links = { a: 'https://x/a', b: 'https://x/b' };
    expect(pruneAuthLinks(links, [needs, server('b', 'available', null)])).toEqual({ a: 'https://x/a' });
    expect(pruneAuthLinks({ a: 'https://x/a' }, [needs])).toEqual({ a: 'https://x/a' });
  });
});
