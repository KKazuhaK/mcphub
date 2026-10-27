import { jest } from '@jest/globals';
import type { IGroup, IUser, ServerConfig, ServerInfo } from '../../src/types/index.js';

const teamGroup: IGroup = {
  id: 'group-1',
  name: 'team',
  owner: 'admin',
  servers: ['alpha', 'beta', 'gamma'].map((name) => ({
    name,
    tools: 'all',
    prompts: 'all',
    resources: 'all',
  })),
};

const mockGroupDao = {
  findAll: jest.fn(async () => [teamGroup]),
  findByName: jest.fn(async (name: string) => (name === teamGroup.name ? teamGroup : null)),
  findById: jest.fn(async (id: string) => (id === teamGroup.id ? teamGroup : null)),
};

const mockServerDao = {
  delete: jest.fn(async () => true),
  findAll: jest.fn(async () => []),
  findById: jest.fn(async (name: string) => ({
    name,
    enabled: true,
    tools: {},
    prompts: {},
    resources: {},
  })),
};

// In-memory stand-in for the selection store.
const selectionRows: Array<{
  username: string;
  serverName: string;
  selected: boolean;
  updatedAt: string;
}> = [];
const mockSelectionDao = {
  listByUsername: jest.fn(async (username: string) =>
    selectionRows.filter((row) => row.username === username),
  ),
  save: jest.fn(async (selection: (typeof selectionRows)[number]) => {
    const index = selectionRows.findIndex(
      (row) => row.username === selection.username && row.serverName === selection.serverName,
    );
    if (index >= 0) selectionRows.splice(index, 1);
    selectionRows.push(selection);
  }),
  delete: jest.fn(async () => undefined),
  renameServer: jest.fn(async () => undefined),
};

let workspaceEnabled = true;
const sessionUsers = new Map<string, string>();

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getUserServerSelectionDao: jest.fn(() => mockSelectionDao),
  getCredentialBindingDao: jest.fn(() => ({ delete: jest.fn(async () => undefined) })),
}));

jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: jest.fn(() => ({ workspace: { enabled: workspaceEnabled } })),
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: jest.fn(() => false),
}));

jest.mock('../../src/dao/index.js', () => ({
  getGroupDao: jest.fn(() => mockGroupDao),
  getServerDao: jest.fn(() => mockServerDao),
  getSystemConfigDao: jest.fn(() => ({ get: jest.fn(async () => ({})) })),
  getBuiltinPromptDao: jest.fn(() => ({
    findEnabled: jest.fn(async () => []),
    findByName: jest.fn(async () => null),
  })),
  getBuiltinResourceDao: jest.fn(() => ({
    findEnabled: jest.fn(async () => []),
    findByUri: jest.fn(async () => null),
  })),
}));

// Visibility rule stand-in: servers owned by "nobody" are visible to no one.
jest.mock('../../src/services/services.js', () => ({
  getDataService: jest.fn(() => ({
    filterData: (data: any[]) => data.filter((item) => item.owner !== 'nobody'),
  })),
}));

const sessionGroups: Record<string, string> = {
  'aggregate-session': '',
  'beta-session': 'beta',
  'secret-session': 'secret',
  'solo-session': 'solo',
  'hidden-session': 'hidden',
  'ghost-session': 'ghost',
  'missing-session': 'missing',
  'alpha-session': 'alpha',
  'team-session': 'team',
  'smart-session': '$smart',
  'smart-team-session': '$smart/team',
};

jest.mock('../../src/services/sseService.js', () => ({
  getGroup: jest.fn((sessionId: string) => sessionGroups[sessionId]),
  getSessionUsername: jest.fn((sessionId: string) => sessionUsers.get(sessionId)),
}));

const mockHandleSearchToolsRequest = jest.fn<(...args: any[]) => Promise<any>>();
const mockInitSmartRoutingService = jest.fn();
jest.mock('../../src/services/smartRoutingService.js', () => ({
  initSmartRoutingService: mockInitSmartRoutingService,
  getSmartRoutingTools: jest.fn(),
  handleSearchToolsRequest: mockHandleSearchToolsRequest,
  handleDescribeToolRequest: jest.fn(),
  isSmartRoutingGroup: jest.fn((group?: string) => Boolean(group?.startsWith('$smart'))),
}));

const mockLogToolCall = jest.fn<(...args: any[]) => Promise<void>>(async () => undefined);
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: jest.fn(() => ({ logToolCall: mockLogToolCall })),
}));

jest.mock('../../src/services/hostedAuthService.js', () => ({
  assertHostedToolAllowed: jest.fn(),
  filterHostedTools: jest.fn((_auth, _serverName, tools) => tools),
  reserveHostedToolCall: jest.fn(async () => null),
  settleHostedToolCall: jest.fn(async () => undefined),
}));

jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn(),
}));

jest.mock('../../src/services/oauthService.js', () => ({
  initializeAllOAuthClients: jest.fn(),
}));

jest.mock('../../src/services/mcpOAuthProvider.js', () => ({
  createOAuthProvider: jest.fn(),
}));

jest.mock('../../src/services/keepAliveService.js', () => ({
  setupClientKeepAlive: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/proxy.js', () => ({
  createFetchWithProxy: jest.fn(),
  getProxyConfigFromEnv: jest.fn(() => undefined),
}));

jest.mock('../../src/config/index.js', () => ({
  expandEnvVars: jest.fn((value: string) => value),
  replaceEnvVars: jest.fn((value: unknown) => value),
  getNameSeparator: jest.fn(() => '::'),
  default: { mcpHubName: 'test-hub', mcpHubVersion: '1.0.0', initTimeout: 60000 },
}));

const mockAcquire = jest.fn<(...args: any[]) => Promise<any>>();
jest.mock('../../src/services/principalRuntimeService.js', () => ({
  PrincipalRuntimeService: class {
    acquire = (...args: unknown[]) => mockAcquire(...args);
    invalidate = jest.fn();
  },
}));

// Binding storage stands in for the encrypted store; everything else is the real module.
const mockCredentialStatus = jest.fn<(...args: any[]) => Promise<{ configured: boolean }>>();
jest.mock('../../src/services/credentialBindingService.js', () => ({
  ...jest.requireActual('../../src/services/credentialBindingService.js'),
  getCredentialBindingStatus: (...args: unknown[]) => mockCredentialStatus(...(args as [])),
}));

import {
  cleanupAllServers,
  getServerByName,
  getServersInfo,
  getMcpServer,
  handleCallToolRequest,
  handleGetPromptRequest,
  handleListToolsRequest,
  handleReadResourceRequest,
  setServerInfosForTest,
} from '../../src/services/mcpService.js';
import {
  credentialBindingEvents,
  missingCredentialError,
} from '../../src/services/credentialBindingService.js';
import { logger } from '../../src/utils/logger.js';
import { UserContextService } from '../../src/services/userContextService.js';
import {
  clearServerSelectionCache,
  setServerSelected,
} from '../../src/services/userServerSelectionService.js';
import {
  clearUserServerFailures,
  getUserServerFailure,
  recordUserServerFailure,
} from '../../src/services/userServerFailureStore.js';
import {
  clearUserListedNames,
  recordUserListedNames,
} from '../../src/services/userServerListedNamesStore.js';
import {
  CredentialBindingConfigError,
  CredentialBindingConflictError,
  CredentialBindingError,
} from '../../src/utils/credentialTemplate.js';
import { createUpstreamRequestError, UpstreamRequestError } from '../../src/utils/upstreamError.js';

const callTools: Record<string, jest.Mock<(...args: any[]) => Promise<any>>> = {};

const upstream = (name: string, config: Partial<ServerConfig> = {}): ServerInfo => {
  callTools[name] = jest.fn(async () => ({ content: [{ type: 'text', text: `${name} ok` }] }));
  return {
    name,
    status: 'connected',
    enabled: true,
    config,
    tools: [{ name: `${name}::ping`, description: 'Ping', inputSchema: { type: 'object' } }],
    prompts: [{ name: `${name}::hello`, description: 'Hello', arguments: [] }],
    resources: [{ name: `${name}-doc`, uri: `test://${name}` }],
    client: {
      callTool: callTools[name],
      getPrompt: jest.fn(async () => ({ messages: [] })),
      readResource: jest.fn(async () => ({ contents: [{ uri: `test://${name}`, text: name }] })),
    },
    options: {},
  } as unknown as ServerInfo;
};

const alice = { username: 'alice', password: '', isAdmin: false } as IUser;
const bob = { username: 'bob', password: '', isAdmin: false } as IUser;

const as = <T>(user: IUser | null, fn: () => Promise<T>) =>
  UserContextService.getInstance().runWithContext(fn, user);

const call = (
  user: IUser | null,
  name: string,
  sessionId = 'aggregate-session',
  extra: object = {},
) =>
  as(user, () =>
    handleCallToolRequest({ params: { name, arguments: {} } }, { sessionId, ...extra }),
  );

const toolNames = async (user: IUser | null, sessionId = 'aggregate-session') =>
  (await as(user, () => handleListToolsRequest({}, { sessionId }))).tools
    .map((tool: { name: string }) => tool.name)
    .sort();

const admin = { username: 'root', password: '', isAdmin: true } as IUser;

const metaOf = (result: any) => result._meta?.['mcphub/status'];

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const LATER = '2026-10-27T18:00:00.000Z';
const EARLIER = '2026-10-27T06:00:00.000Z';

describe('mcpService workspace maintenance and per-user pause', () => {
  let now = NOW;

  const load = (configs: Record<string, Partial<ServerConfig>>) =>
    setServerInfosForTest(Object.entries(configs).map(([name, config]) => upstream(name, config)));

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    now = NOW;
    selectionRows.length = 0;
    sessionUsers.clear();
    clearServerSelectionCache();
    clearUserServerFailures();
    clearUserListedNames();
    workspaceEnabled = true;
    cleanupAllServers();
    for (const user of ['alice', 'bob']) {
      for (const name of ['alpha', 'beta']) await setServerSelected(user, name, true);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    cleanupAllServers();
  });

  describe('maintenance', () => {
    it('blocks calls with the maintenance status, end time and admin message', async () => {
      load({
        alpha: { maintenance: { until: LATER, message: 'Upgrading the database.' } },
        beta: {},
      });

      const result = await call(alice, 'alpha::ping');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        `'alpha' is under maintenance until ${LATER}. Try again later. Upgrading the database.`,
      );
      expect(metaOf(result)).toEqual({
        server: 'alpha',
        code: 'maintenance',
        action: 'retry_later',
      });
      expect(callTools.alpha).not.toHaveBeenCalled();
      expect((await call(bob, 'alpha::ping')).isError).toBe(true);
    });

    it('works without an end time or message', async () => {
      load({ alpha: { maintenance: {} }, beta: {} });

      const result = await call(alice, 'alpha::ping');

      expect(result.content[0].text).toBe("'alpha' is under maintenance. Try again later.");
      expect(metaOf(result).code).toBe('maintenance');
    });

    it('leaves the same trace as any other gated call', async () => {
      const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      load({ alpha: { maintenance: {} }, beta: {} });

      await call(alice, 'alpha::ping');

      expect(mockLogToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'alpha',
          tool: 'ping',
          status: 'error',
          errorMessage: expect.stringMatching(/\(reason: maintenance\)$/),
        }),
      );
      expect(logged).toHaveBeenCalledWith(
        'Error handling CallToolRequest',
        expect.objectContaining({ reason: 'maintenance' }),
      );
    });

    it('ends by itself once the end time passes, with no write', async () => {
      load({ alpha: { maintenance: { until: LATER } }, beta: {} });
      expect((await call(alice, 'alpha::ping')).isError).toBe(true);
      expect(await toolNames(alice)).toEqual(['beta::ping']);

      now = Date.parse(LATER) + 1;

      expect((await call(alice, 'alpha::ping')).content[0].text).toBe('alpha ok');
      expect(await toolNames(alice)).toEqual(['alpha::ping', 'beta::ping']);
    });

    it('treats a window whose end is already past as over', async () => {
      load({ alpha: { maintenance: { until: EARLIER } }, beta: {} });

      expect((await call(alice, 'alpha::ping')).content[0].text).toBe('alpha ok');
    });

    it('does not disconnect the upstream or change enabled', async () => {
      load({ alpha: { maintenance: {} }, beta: {} });

      await call(alice, 'alpha::ping');

      const info = getServerByName('alpha')!;
      expect(info.enabled).toBe(true);
      expect(info.status).toBe('connected');
      expect(info.client).toBeDefined();
    });

    it('ranks below paused and above everything else', async () => {
      load({
        alpha: { maintenance: {}, pausedUsers: ['alice'] },
        beta: { maintenance: {} },
      });
      mockCredentialStatus.mockResolvedValue({ configured: false });

      expect(metaOf(await call(alice, 'alpha::ping')).code).toBe('paused');
      expect(metaOf(await call(bob, 'alpha::ping')).code).toBe('maintenance');
      // Not selected still outranks both.
      await setServerSelected('bob', 'beta', false);
      expect(metaOf(await call(bob, 'beta::ping')).code).toBe('not_selected');
    });
  });

  describe('pausedUsers', () => {
    it('pauses the server for the listed users only', async () => {
      load({ alpha: { pausedUsers: ['alice'] }, beta: {} });

      const blocked = await call(alice, 'alpha::ping');
      expect(blocked.content[0].text).toBe("'alpha' is paused by an administrator.");
      expect(metaOf(blocked)).toEqual({ server: 'alpha', code: 'paused', action: 'contact_admin' });
      expect(callTools.alpha).not.toHaveBeenCalled();

      expect((await call(bob, 'alpha::ping')).content[0].text).toBe('alpha ok');
      expect((await call(alice, 'beta::ping')).content[0].text).toBe('beta ok');
    });

    it('leaves the server out of the lists of listed users only', async () => {
      load({ alpha: { pausedUsers: ['alice'] }, beta: {} });

      expect(await toolNames(alice)).toEqual(['beta::ping']);
      expect(await toolNames(bob)).toEqual(['alpha::ping', 'beta::ping']);
    });

    it('blocks prompts and resources the same way', async () => {
      load({ alpha: { pausedUsers: ['alice'] }, beta: {} });

      const prompt = await as(alice, () =>
        handleGetPromptRequest(
          { params: { name: 'alpha::hello' } },
          { sessionId: 'aggregate-session' },
        ),
      );
      expect(prompt.isError).toBe(true);
      expect(metaOf(prompt).code).toBe('paused');
      const resource = await as(alice, () =>
        handleReadResourceRequest(
          { params: { uri: 'test://alpha' } },
          { sessionId: 'aggregate-session' },
        ),
      );
      expect(metaOf(resource).code).toBe('paused');
    });
  });

  // Pause and maintenance are access controls, not selection: they apply on every route.
  describe.each([
    ['all-servers route', 'aggregate-session', {}],
    ['single-server route', 'alpha-session', {}],
    ['admin group route', 'team-session', {}],
    ['dashboard call naming its server', 'aggregate-session', { server: 'alpha' }],
    ['dashboard call', 'aggregate-session', { dashboard: true }],
  ])('on the %s', (_route, sessionId, extra) => {
    const callAlpha = (user: IUser | null) => call(user, 'alpha::ping', sessionId, extra);
    // Selection still narrows the all-servers and single-server routes, as before.
    const selectionApplies =
      ['aggregate-session', 'alpha-session'].includes(sessionId) && Object.keys(extra).length === 0;

    beforeEach(async () => {
      await setServerSelected('root', 'alpha', true);
    });

    it('blocks everyone but administrators during maintenance, selected or not', async () => {
      load({ alpha: { maintenance: { message: 'Upgrading.' } }, beta: {}, gamma: {} });
      if (!selectionApplies) await setServerSelected('bob', 'alpha', false);

      for (const user of [alice, bob]) {
        const result = await callAlpha(user);
        expect(metaOf(result)).toEqual({
          server: 'alpha',
          code: 'maintenance',
          action: 'retry_later',
        });
        expect(result.content[0].text).toContain('Upgrading.');
      }
      expect(callTools.alpha).not.toHaveBeenCalled();
      expect((await callAlpha(admin)).content[0].text).toBe('alpha ok');
    });

    it('blocks a request without a user, as a system key makes, during maintenance', async () => {
      load({ alpha: { maintenance: {} }, beta: {}, gamma: {} });

      expect(metaOf(await callAlpha(null)).code).toBe('maintenance');
      expect(callTools.alpha).not.toHaveBeenCalled();
    });

    it('blocks the listed users only, administrators included', async () => {
      load({ alpha: { pausedUsers: ['alice', 'root'] }, beta: {}, gamma: {} });

      expect(metaOf(await callAlpha(alice))).toEqual({
        server: 'alpha',
        code: 'paused',
        action: 'contact_admin',
      });
      expect(metaOf(await callAlpha(admin)).code).toBe('paused');
      expect((await callAlpha(bob)).content[0].text).toBe('alpha ok');
      expect((await callAlpha(null)).content[0].text).toBe('alpha ok');
    });

    it('leaves the same trace as any other gated call', async () => {
      load({ alpha: { maintenance: {} }, beta: {}, gamma: {} });
      await callAlpha(bob);
      expect(mockLogToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'alpha',
          errorMessage: expect.stringMatching(/\(reason: maintenance\)$/),
        }),
      );
    });
  });

  describe('lists on every route', () => {
    it('leave out a server in maintenance or paused for the requester', async () => {
      load({
        alpha: { maintenance: {} },
        beta: { pausedUsers: ['bob'] },
        gamma: {},
      });

      // Group route: the group is the admin's curation, but access still applies.
      expect(await toolNames(alice, 'team-session')).toEqual(['beta::ping', 'gamma::ping']);
      expect(await toolNames(bob, 'team-session')).toEqual(['gamma::ping']);
      expect(await toolNames(null, 'team-session')).toEqual(['beta::ping', 'gamma::ping']);
      expect(await toolNames(admin, 'team-session')).toEqual([
        'alpha::ping',
        'beta::ping',
        'gamma::ping',
      ]);
    });

    it('keep selection scoped to the routes it always applied to', async () => {
      load({ alpha: {}, beta: {}, gamma: {} });
      await setServerSelected('alice', 'gamma', false);

      // Selected alpha and beta on the aggregate route; the group route is not narrowed.
      expect(await toolNames(alice)).toEqual(['alpha::ping', 'beta::ping']);
      expect(await toolNames(alice, 'team-session')).toEqual([
        'alpha::ping',
        'beta::ping',
        'gamma::ping',
      ]);
    });
  });

  describe('scope of the access gate on a group route', () => {
    it('does not reveal maintenance on a server outside the group, to a userless key or a user', async () => {
      load({
        alpha: {},
        beta: {},
        gamma: {},
        delta: { maintenance: { until: LATER, message: 'Secret plans.' } },
      });

      for (const user of [null, bob]) {
        const outside = await call(user, 'delta::ping', 'team-session');
        const missing = await call(user, 'delta::missing', 'team-session');

        expect(outside._meta).toBeUndefined();
        expect(JSON.stringify(outside)).not.toMatch(/maintenance|Secret plans|2026-10-27T18/);
        expect(outside.isError).toBe(true);
        // Byte-identical to a tool that does not exist, apart from the name asked for.
        expect(outside.content[0].text.replace('delta::ping', 'X')).toBe(
          missing.content[0].text.replace('delta::missing', 'X'),
        );
      }
      expect(callTools.delta).not.toHaveBeenCalled();
    });

    it('still gates a server inside the group for a userless key', async () => {
      load({ alpha: { maintenance: {} }, beta: {}, gamma: {}, delta: {} });

      expect(metaOf(await call(null, 'alpha::ping', 'team-session')).code).toBe('maintenance');
    });
  });

  describe('a group route call that was not gated', () => {
    it('is not told it was paused or in maintenance', async () => {
      load({ alpha: {}, beta: {}, gamma: {} });
      expect((await call(alice, 'alpha::ping', 'team-session')).content[0].text).toBe('alpha ok');
    });

    it('lets an administrator through a maintenance window without a status', async () => {
      load({ alpha: { maintenance: {} }, beta: {}, gamma: {} });
      const result = await call(admin, 'alpha::ping', 'team-session');
      expect(result._meta).toBeUndefined();
      expect(result.content[0].text).toBe('alpha ok');
    });
  });

  describe('when the workspace setting is off', () => {
    beforeEach(() => {
      workspaceEnabled = false;
    });

    it('ignores both fields for lists and calls', async () => {
      load({
        alpha: { pausedUsers: ['alice'], maintenance: { message: 'down' } },
        beta: {},
      });

      expect((await call(alice, 'alpha::ping')).content[0].text).toBe('alpha ok');
      expect(await toolNames(alice)).toEqual(['alpha::ping', 'beta::ping']);
    });

    it('ignores both fields on group routes, dashboard calls and system keys too', async () => {
      load({ alpha: { maintenance: {}, pausedUsers: ['alice'] }, beta: {}, gamma: {} });

      expect((await call(alice, 'alpha::ping', 'team-session')).content[0].text).toBe('alpha ok');
      expect(
        (await call(null, 'alpha::ping', 'aggregate-session', { server: 'alpha' })).content[0].text,
      ).toBe('alpha ok');
      expect(await toolNames(null, 'team-session')).toEqual([
        'alpha::ping',
        'beta::ping',
        'gamma::ping',
      ]);
    });
  });

  describe('server list', () => {
    it('reports an active maintenance window but never the pause list', async () => {
      mockServerDao.findAll.mockResolvedValueOnce([
        {
          name: 'alpha',
          enabled: true,
          maintenance: { until: LATER, message: 'Soon.' },
          pausedUsers: ['bob'],
        },
        { name: 'beta', enabled: true, maintenance: { until: EARLIER } },
      ] as any);
      load({ alpha: {}, beta: {} });

      const infos = await getServersInfo(undefined, undefined, alice);

      expect(infos.find((info) => info.name === 'alpha')?.maintenance).toEqual({
        until: LATER,
        message: 'Soon.',
      });
      expect(infos.find((info) => info.name === 'beta')?.maintenance).toBeUndefined();
      expect(JSON.stringify(infos)).not.toContain('pausedUsers');
    });
  });
});
