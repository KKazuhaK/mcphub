let workspaceEnabled = true;

jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: jest.fn(() => ({ workspace: { enabled: workspaceEnabled } })),
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: jest.fn(() => false),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getUserServerSelectionDao: jest.fn(),
  getCredentialBindingDao: jest.fn(),
}));

import type { UserServerStatusCode } from '../../src/types/index.js';
import {
  CredentialBindingConfigError,
  CredentialBindingConflictError,
  CredentialBindingError,
  MissingCredentialError,
} from '../../src/utils/credentialTemplate.js';
import { createUpstreamRequestError } from '../../src/utils/upstreamError.js';
import {
  AUTH_FAILURE_TTL_MS,
  AUTH_REJECTION_WINDOW_MS,
  MAX_FAILURE_ENTRIES,
  RUNTIME_FAILURE_TTL_MS,
  clearUserServerFailure,
  clearUserServerFailures,
  getUserServerFailure,
  getUserServerFailureCount,
  recordUserServerFailure,
} from '../../src/services/userServerFailureStore.js';
import {
  MAX_LISTED_ENTRIES,
  clearUserListedNames,
  getUserListedEntryCount,
  hasUserListedName,
  recordUserListedNames,
} from '../../src/services/userServerListedNamesStore.js';
import {
  USER_SERVER_STATUS_ACTIONS,
  USER_SERVER_STATUS_CODES,
  buildUserServerStatus,
  classifyRuntimePreparationFailure,
  countUserServerStatuses,
  isAdminBlockedForUser,
  isBlockingStatus,
  isStructuredCredentialError,
  reportCredentialRejected,
  reportRuntimePreparationFailure,
  reportRuntimeReady,
  reportUpstreamSuccess,
  resolveEndpointState,
  resolveUserServerState,
  type UserServerStateInputs,
} from '../../src/services/userServerStatusService.js';

const base: UserServerStateInputs = {
  selected: true,
  enabled: true,
  personalAuth: 'not_required',
  sharedConnectionFailed: false,
};
const resolve = (overrides: Partial<UserServerStateInputs>) =>
  resolveUserServerState({ ...base, ...overrides });

describe('resolveUserServerState', () => {
  it('is available when nothing applies', () => {
    expect(resolve({})).toEqual({ code: 'available' });
    expect(resolve({ personalAuth: 'configured' }).code).toBe('available');
  });

  it.each<[string, Partial<UserServerStateInputs>, UserServerStatusCode]>([
    ['not selected', { selected: false }, 'not_selected'],
    ['paused', { enabled: false }, 'paused'],
    ['paused for this user only', { pausedForUser: true }, 'paused'],
    ['under maintenance', { maintenance: {} }, 'maintenance'],
    ['personal auth missing', { personalAuth: 'missing' }, 'needs_auth'],
    ['a user who cannot hold credentials', { personalAuth: 'ineligible' }, 'needs_auth'],
    ['personal OAuth disconnected', { personalAuth: 'revoked' }, 'revoked'],
    [
      'credential rejected',
      { personalAuth: 'configured', failure: { kind: 'auth', at: 1 } },
      'credential_invalid',
    ],
    ['shared server down', { sharedConnectionFailed: true }, 'error'],
    ['recent runtime failure', { failure: { kind: 'runtime', at: 1 } }, 'error'],
  ])('reports %s', (_name, overrides, code) => {
    expect(resolve(overrides).code).toBe(code);
  });

  it('keeps the documented priority order', () => {
    const everything: UserServerStateInputs = {
      selected: false,
      enabled: false,
      pausedForUser: true,
      maintenance: {},
      personalAuth: 'missing',
      sharedConnectionFailed: true,
      failure: { kind: 'auth', at: 1 },
    };
    const order: Array<[Partial<UserServerStateInputs>, UserServerStatusCode]> = [
      [{}, 'not_selected'],
      [{ selected: true }, 'paused'],
      [{ selected: true, enabled: true }, 'paused'],
      [{ selected: true, enabled: true, pausedForUser: false }, 'maintenance'],
      [
        { selected: true, enabled: true, pausedForUser: false, maintenance: undefined },
        'needs_auth',
      ],
      [
        {
          selected: true,
          enabled: true,
          pausedForUser: false,
          maintenance: undefined,
          personalAuth: 'revoked',
        },
        'revoked',
      ],
      [
        {
          selected: true,
          enabled: true,
          pausedForUser: false,
          maintenance: undefined,
          personalAuth: 'configured',
        },
        'credential_invalid',
      ],
      [
        {
          selected: true,
          enabled: true,
          pausedForUser: false,
          maintenance: undefined,
          personalAuth: 'configured',
          failure: undefined,
        },
        'error',
      ],
    ];
    for (const [overrides, code] of order)
      expect(resolveUserServerState({ ...everything, ...overrides }).code).toBe(code);
  });

  it('dates remembered failures and disconnects', () => {
    expect(resolve({ personalAuth: 'configured', failure: { kind: 'auth', at: 0 } })).toEqual({
      code: 'credential_invalid',
      since: '1970-01-01T00:00:00.000Z',
    });
    expect(resolve({ personalAuth: 'revoked', revokedAt: '2026-01-01T00:00:00.000Z' }).since).toBe(
      '2026-01-01T00:00:00.000Z',
    );
  });

  it('reports a rejected credential on a shared server as a plain error', () => {
    expect(resolve({ failure: { kind: 'auth', at: 1 } }).code).toBe('error');
  });

  it('sends users who cannot hold credentials, and a broken store, to the administrator', () => {
    expect(resolve({ personalAuth: 'ineligible' }).action).toBe('contact_admin');
    expect(resolve({ failure: { kind: 'misconfigured', at: 1 } })).toMatchObject({
      code: 'error',
      action: 'contact_admin',
    });
    expect(resolve({ failure: { kind: 'runtime', at: 1 } }).action).toBeUndefined();
  });

  it('blocks calls only for states that follow from configuration', () => {
    const blocking = USER_SERVER_STATUS_CODES.filter(isBlockingStatus);
    expect(blocking.sort()).toEqual([
      'maintenance',
      'needs_auth',
      'not_selected',
      'paused',
      'revoked',
    ]);
  });
});

describe('isAdminBlockedForUser', () => {
  const NOW = Date.parse('2026-10-27T12:00:00.000Z');
  const window = { maintenance: { until: '2026-10-27T18:00:00.000Z' } };

  it('lets administrators bypass maintenance but not a pause that lists them', () => {
    expect(isAdminBlockedForUser(window, { username: 'root', isAdmin: true }, NOW)).toBe(false);
    expect(isAdminBlockedForUser(window, { username: 'bob', isAdmin: false }, NOW)).toBe(true);
    expect(
      isAdminBlockedForUser({ pausedUsers: ['root'] }, { username: 'root', isAdmin: true }, NOW),
    ).toBe(true);
  });

  it('blocks a request without a user during maintenance only', () => {
    expect(isAdminBlockedForUser(window, null, NOW)).toBe(true);
    expect(isAdminBlockedForUser({ pausedUsers: ['bob'] }, undefined, NOW)).toBe(false);
  });

  it('ends with the window', () => {
    expect(isAdminBlockedForUser(window, null, Date.parse('2026-10-27T18:00:00.000Z'))).toBe(false);
  });
});

describe('status presentation', () => {
  it('gives every state a stable code, action and server-specific message', () => {
    const codes = Object.keys(USER_SERVER_STATUS_ACTIONS) as UserServerStatusCode[];
    expect(codes.sort()).toEqual(
      [
        'available',
        'credential_invalid',
        'error',
        'maintenance',
        'needs_auth',
        'not_selected',
        'paused',
        'revoked',
      ].sort(),
    );
    expect(USER_SERVER_STATUS_ACTIONS).toMatchObject({
      available: null,
      not_selected: 'select',
      paused: 'contact_admin',
      maintenance: 'retry_later',
      needs_auth: 'connect',
      revoked: 'connect',
      credential_invalid: 'connect',
      error: 'retry_later',
    });
    for (const code of codes) {
      const status = buildUserServerStatus({ code }, 'alpha', 'en');
      expect(status.code).toBe(code);
      expect(status.action).toBe(USER_SERVER_STATUS_ACTIONS[code]);
      expect(status.message).toContain('alpha');
    }
  });

  it('words a maintenance status with its end time and the admin message', () => {
    const until = '2026-10-27T18:00:00.000Z';
    expect(buildUserServerStatus({ code: 'maintenance', maintenance: {} }, 'alpha', 'en')).toEqual({
      code: 'maintenance',
      message: "'alpha' is under maintenance. Try again later.",
      action: 'retry_later',
    });
    expect(
      buildUserServerStatus(
        { code: 'maintenance', maintenance: { until, message: 'Back soon.' } },
        'alpha',
        'en',
      ),
    ).toEqual({
      code: 'maintenance',
      message: `'alpha' is under maintenance until ${until}. Try again later. Back soon.`,
      action: 'retry_later',
      until,
    });
  });

  it('ignores a message that does not belong to a maintenance status', () => {
    const status = buildUserServerStatus(
      { code: 'paused', maintenance: { message: 'secret' } },
      'alpha',
      'en',
    );
    expect(status.message).toBe("'alpha' is paused by an administrator.");
    expect(status).not.toHaveProperty('until');
  });

  it('includes since only when known', () => {
    expect(buildUserServerStatus({ code: 'error' }, 'a', 'en')).not.toHaveProperty('since');
    expect(buildUserServerStatus({ code: 'error', since: 'T' }, 'a', 'en').since).toBe('T');
  });

  it('counts every state and derives the endpoint state', () => {
    expect(countUserServerStatuses(['available', 'available', 'paused'])).toEqual({
      available: 2,
      not_selected: 0,
      paused: 1,
      maintenance: 0,
      needs_auth: 0,
      revoked: 0,
      credential_invalid: 0,
      error: 0,
    });
    expect(resolveEndpointState([])).toBe('empty');
    expect(resolveEndpointState(['not_selected'])).toBe('empty');
    expect(resolveEndpointState(['needs_auth', 'paused'])).toBe('empty');
    expect(resolveEndpointState(['available', 'not_selected'])).toBe('normal');
    expect(resolveEndpointState(['available', 'needs_auth'])).toBe('partial');
  });
});

describe('runtime preparation failure classification', () => {
  it.each([
    [new MissingCredentialError('missing'), 'ignore'],
    [new CredentialBindingConflictError('Personal authorization changed; reconnect'), 'runtime'],
    [new CredentialBindingConfigError('Invalid encryption key'), 'misconfigured'],
    [new CredentialBindingError('Invalid URL credential template'), 'misconfigured'],
    [createUpstreamRequestError('s', 'connect', { status: 401 }, {}), 'auth'],
    [createUpstreamRequestError('s', 'connect', { code: 401 }, {}), 'auth'],
    [
      createUpstreamRequestError(
        's',
        'connect',
        {
          response: {
            status: 400,
            headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
          },
        },
        {},
      ),
      'auth',
    ],
    [createUpstreamRequestError('s', 'connect', { status: 403 }, {}), 'runtime'],
    [createUpstreamRequestError('s', 'connect', { status: 500 }, {}), 'runtime'],
    [new Error('401 Unauthorized'), 'runtime'],
    ['boom', 'runtime'],
  ])('classifies %#', (error, kind) => {
    expect(classifyRuntimePreparationFailure(error)).toBe(kind);
  });
});

describe('structured credential errors', () => {
  const result = (text: string, isError = true) => ({ isError, content: [{ type: 'text', text }] });

  it('recognizes the two structured codes in tool results only', () => {
    expect(isStructuredCredentialError(result('{"error":"CREDENTIAL_INVALID"}'))).toBe(true);
    expect(isStructuredCredentialError(result('{ "error": "CONNECTION_REVOKED" }'))).toBe(true);
    expect(
      isStructuredCredentialError({
        isError: true,
        structuredContent: { error: 'CREDENTIAL_INVALID' },
      }),
    ).toBe(true);
  });

  it('ignores everything else', () => {
    expect(isStructuredCredentialError(result('{"error":"CREDENTIAL_INVALID"}', false))).toBe(
      false,
    );
    expect(isStructuredCredentialError(result('{"error":"RATE_LIMITED"}'))).toBe(false);
    expect(isStructuredCredentialError(result('API call failed: 403 Forbidden'))).toBe(false);
    expect(isStructuredCredentialError(result('Order 401 not found'))).toBe(false);
    expect(isStructuredCredentialError(result('error CREDENTIAL_INVALID happened'))).toBe(false);
    expect(isStructuredCredentialError(null)).toBe(false);
  });
});

describe('failure store', () => {
  beforeEach(() => clearUserServerFailures());

  it('keys failures by user and server', () => {
    recordUserServerFailure('alice', 'alpha', 'auth');
    expect(getUserServerFailure('alice', 'alpha')?.kind).toBe('auth');
    expect(getUserServerFailure('bob', 'alpha')).toBeUndefined();
    expect(getUserServerFailure('alice', 'beta')).toBeUndefined();
  });

  it('replaces an earlier failure for the same pair', () => {
    const now = Date.now();
    recordUserServerFailure('alice', 'alpha', 'runtime', now);
    recordUserServerFailure('alice', 'alpha', 'auth', now + 1000);
    expect(getUserServerFailureCount()).toBe(1);
    expect(getUserServerFailure('alice', 'alpha', now + 1000)?.kind).toBe('auth');
    expect(clearUserServerFailure('alice', 'alpha')).toBe(true);
    expect(clearUserServerFailure('alice', 'alpha')).toBe(false);
  });

  it('expires runtime failures quickly and auth failures slowly', () => {
    recordUserServerFailure('alice', 'alpha', 'runtime', 0);
    recordUserServerFailure('alice', 'beta', 'auth', 0);
    expect(getUserServerFailure('alice', 'alpha', RUNTIME_FAILURE_TTL_MS - 1)).toBeDefined();
    expect(getUserServerFailure('alice', 'alpha', RUNTIME_FAILURE_TTL_MS)).toBeUndefined();
    expect(getUserServerFailure('alice', 'beta', RUNTIME_FAILURE_TTL_MS)).toBeDefined();
    expect(getUserServerFailure('alice', 'beta', AUTH_FAILURE_TTL_MS)).toBeUndefined();
  });

  it('clears only the requested kind when asked', () => {
    recordUserServerFailure('alice', 'alpha', 'auth');
    expect(clearUserServerFailure('alice', 'alpha', 'runtime')).toBe(false);
    expect(clearUserServerFailure('alice', 'alpha', 'auth')).toBe(true);
  });

  it('is bounded and evicts the least recently recorded entry', () => {
    for (let index = 0; index < MAX_FAILURE_ENTRIES + 5; index++)
      recordUserServerFailure('alice', `server-${index}`, 'runtime');
    expect(getUserServerFailureCount()).toBe(MAX_FAILURE_ENTRIES);
    expect(getUserServerFailure('alice', 'server-0')).toBeUndefined();
    expect(getUserServerFailure('alice', `server-${MAX_FAILURE_ENTRIES + 4}`)).toBeDefined();
    // Recording again refreshes the entry's position.
    recordUserServerFailure('alice', 'server-5', 'runtime');
    recordUserServerFailure('alice', 'fresh', 'runtime');
    expect(getUserServerFailure('alice', 'server-5')).toBeDefined();
    expect(getUserServerFailure('alice', 'server-6')).toBeUndefined();
  });

  it('removes a user, a server, or a pair', () => {
    recordUserServerFailure('alice', 'alpha', 'auth');
    recordUserServerFailure('alice', 'beta', 'auth');
    recordUserServerFailure('bob', 'alpha', 'auth');
    clearUserServerFailures({ serverName: 'alpha', username: 'alice' });
    expect(getUserServerFailureCount()).toBe(2);
    clearUserServerFailures({ serverName: 'alpha' });
    expect(getUserServerFailure('bob', 'alpha')).toBeUndefined();
    clearUserServerFailures({ username: 'alice' });
    expect(getUserServerFailureCount()).toBe(0);
  });
});

describe('reporting outcomes', () => {
  beforeEach(() => {
    clearUserServerFailures();
    workspaceEnabled = true;
  });

  it('remembers a rejected credential and forgets it on success', () => {
    reportCredentialRejected('alice', 'alpha');
    expect(getUserServerFailure('alice', 'alpha')?.kind).toBe('auth');
    reportUpstreamSuccess('alice', 'alpha');
    expect(getUserServerFailure('alice', 'alpha')).toBeUndefined();
  });

  it('remembers a transport-level 401 while preparing a runtime, and nothing for other errors it ignores', () => {
    reportRuntimePreparationFailure(
      'alice',
      'alpha',
      createUpstreamRequestError('alpha', 'connect', { status: 401 }, {}),
    );
    expect(getUserServerFailure('alice', 'alpha')?.kind).toBe('auth');
    reportRuntimePreparationFailure('alice', 'beta', new MissingCredentialError('missing'));
    expect(getUserServerFailure('alice', 'beta')).toBeUndefined();
    reportRuntimePreparationFailure('alice', 'gamma', new CredentialBindingConfigError('key'));
    expect(getUserServerFailure('alice', 'gamma')?.kind).toBe('misconfigured');
  });

  it('clears a runtime failure when a runtime is ready but keeps a rejected credential', () => {
    reportRuntimePreparationFailure('alice', 'alpha', new Error('spawn failed'));
    reportRuntimeReady('alice', 'alpha');
    expect(getUserServerFailure('alice', 'alpha')).toBeUndefined();
    reportCredentialRejected('alice', 'alpha');
    reportRuntimeReady('alice', 'alpha');
    expect(getUserServerFailure('alice', 'alpha')?.kind).toBe('auth');
  });

  describe('a transport-level refusal', () => {
    const refused = () => createUpstreamRequestError('srv', 'connect', { status: 401 }, {});
    const template = { credentialTemplate: [{ target: 'env', name: 'KEY' }] } as any;
    const oauth = { oauth: { identityMode: 'personal' } } as any;

    it('is one user’s rejected credential when only that user is refused', () => {
      reportRuntimePreparationFailure('alice', 'srv', refused(), Date.now(), template);
      expect(getUserServerFailure('alice', 'srv')?.kind).toBe('auth');
    });

    it('becomes the server’s misconfiguration for every affected user once two users are refused', () => {
      const now = Date.now();
      reportRuntimePreparationFailure('alice', 'srv', refused(), now, template);
      reportRuntimePreparationFailure('bob', 'srv', refused(), now + 1000, template);
      expect(getUserServerFailure('alice', 'srv')?.kind).toBe('misconfigured');
      expect(getUserServerFailure('bob', 'srv')?.kind).toBe('misconfigured');
      // A later user in the window is told the same.
      reportRuntimePreparationFailure('carol', 'srv', refused(), now + 2000, template);
      expect(getUserServerFailure('carol', 'srv')?.kind).toBe('misconfigured');
    });

    it('does not combine refusals outside the window, or on different servers', () => {
      const now = Date.now();
      reportRuntimePreparationFailure('alice', 'srv', refused(), now, template);
      reportRuntimePreparationFailure(
        'bob',
        'srv',
        refused(),
        now + AUTH_REJECTION_WINDOW_MS,
        template,
      );
      expect(getUserServerFailure('bob', 'srv')?.kind).toBe('auth');
      reportRuntimePreparationFailure('carol', 'other', refused(), now, template);
      expect(getUserServerFailure('carol', 'other')?.kind).toBe('auth');
    });

    it('stays per user for personal OAuth', () => {
      reportRuntimePreparationFailure('alice', 'srv', refused(), Date.now(), oauth);
      reportRuntimePreparationFailure('bob', 'srv', refused(), Date.now(), oauth);
      expect(getUserServerFailure('alice', 'srv')?.kind).toBe('auth');
      expect(getUserServerFailure('bob', 'srv')?.kind).toBe('auth');
    });

    it('forgets a user’s refusal when their credentials change or they succeed', () => {
      reportRuntimePreparationFailure('alice', 'srv', refused(), Date.now(), template);
      clearUserServerFailures({ serverName: 'srv', username: 'alice' });
      reportRuntimePreparationFailure('bob', 'srv', refused(), Date.now(), template);
      expect(getUserServerFailure('bob', 'srv')?.kind).toBe('auth');
      reportUpstreamSuccess('bob', 'srv');
      reportRuntimePreparationFailure('carol', 'srv', refused(), Date.now(), template);
      expect(getUserServerFailure('carol', 'srv')?.kind).toBe('auth');
    });
  });

  it('does nothing when the workspace setting is off', () => {
    workspaceEnabled = false;
    reportCredentialRejected('alice', 'alpha');
    reportRuntimePreparationFailure('alice', 'alpha', new Error('x'));
    expect(getUserServerFailureCount()).toBe(0);
  });

  it('ignores calls without a user', () => {
    reportCredentialRejected(undefined, 'alpha');
    expect(getUserServerFailureCount()).toBe(0);
  });
});

describe('listed names store', () => {
  beforeEach(() => clearUserListedNames());

  it('matches only the user whose runtime listed the name', () => {
    recordUserListedNames('alice', 'srv', { tools: [{ name: 'srv::a' }] });
    expect(hasUserListedName('alice', 'srv', 'tools', 'srv::a')).toBe(true);
    expect(hasUserListedName('bob', 'srv', 'tools', 'srv::a')).toBe(false);
    expect(hasUserListedName('alice', 'other', 'tools', 'srv::a')).toBe(false);
    expect(hasUserListedName('alice', 'srv', 'prompts', 'srv::a')).toBe(false);
  });

  it('replaces a kind that was listed again and keeps kinds that came back empty', () => {
    recordUserListedNames('alice', 'srv', {
      tools: [{ name: 'srv::a' }],
      resources: [{ uri: 'test://x' }],
    });
    recordUserListedNames('alice', 'srv', { tools: [{ name: 'srv::b' }] });
    expect(hasUserListedName('alice', 'srv', 'tools', 'srv::a')).toBe(false);
    expect(hasUserListedName('alice', 'srv', 'tools', 'srv::b')).toBe(true);
    expect(hasUserListedName('alice', 'srv', 'resources', 'test://x')).toBe(true);
  });

  it('is bounded and cleared by user, server or entirely', () => {
    for (let index = 0; index < MAX_LISTED_ENTRIES + 3; index++)
      recordUserListedNames('alice', `s${index}`, { tools: [{ name: 'n' }] });
    expect(getUserListedEntryCount()).toBe(MAX_LISTED_ENTRIES);
    expect(hasUserListedName('alice', 's0', 'tools', 'n')).toBe(false);
    clearUserListedNames({ serverName: `s${MAX_LISTED_ENTRIES + 2}` });
    expect(getUserListedEntryCount()).toBe(MAX_LISTED_ENTRIES - 1);
    clearUserListedNames({ username: 'alice' });
    expect(getUserListedEntryCount()).toBe(0);
  });
});
