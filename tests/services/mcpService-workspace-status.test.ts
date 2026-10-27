import { jest } from '@jest/globals';
import type { IGroup, IUser, ServerInfo } from '../../src/types/index.js';

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

const upstream = (name: string, extra: Partial<ServerInfo> = {}): ServerInfo => {
  callTools[name] = jest.fn(async () => ({ content: [{ type: 'text', text: `${name} ok` }] }));
  return {
    name,
    status: 'connected',
    enabled: true,
    tools: [{ name: `${name}::ping`, description: 'Ping', inputSchema: { type: 'object' } }],
    prompts: [{ name: `${name}::hello`, description: 'Hello', arguments: [] }],
    resources: [{ name: `${name}-doc`, uri: `test://${name}` }],
    client: {
      callTool: callTools[name],
      getPrompt: jest.fn(async () => ({ messages: [] })),
      readResource: jest.fn(async () => ({ contents: [{ uri: `test://${name}`, text: name }] })),
    },
    options: {},
    ...extra,
  } as unknown as ServerInfo;
};

// As in production, a server needing personal credentials has no shared cached lists.
const personal = (name: string, extra: Partial<ServerInfo> = {}) =>
  upstream(name, {
    config: { credentialTemplate: [{ target: 'env', name: 'API_KEY' }] },
    tools: [],
    prompts: [],
    resources: [],
    ...extra,
  } as Partial<ServerInfo>);

// What the user's own runtime returns once prepared.
const leased = (name: string) =>
  upstream(name, {
    config: { credentialTemplate: [{ target: 'env', name: 'API_KEY' }] },
  } as Partial<ServerInfo>);

// The user has listed the server's capabilities through their own runtime before.
const seedListed = (username: string, name: string) =>
  recordUserListedNames(username, name, {
    tools: [{ name: `${name}::ping` }],
    prompts: [{ name: `${name}::hello` }],
    resources: [{ uri: `test://${name}` }],
  });

const alice = { username: 'alice', password: '', isAdmin: false } as IUser;
const bob = { username: 'bob', password: '', isAdmin: false } as IUser;

const as = <T>(user: IUser | null, fn: () => Promise<T>) =>
  UserContextService.getInstance().runWithContext(fn, user);

const call = (
  user: IUser | null,
  sessionId: string,
  name: string,
  extra: object = {},
  args: object = {},
) =>
  as(user, () =>
    handleCallToolRequest({ params: { name, arguments: args } }, { sessionId, ...extra }),
  );

const metaOf = (result: any) => result._meta?.['mcphub/status'];

const GENERIC = (name: string) => `Error: Tool not available: ${name}`;
const MISSING_TEXT =
  "Personal credentials required for 'secret'. Bind all required slots in Dashboard → Credentials.";

describe('mcpService workspace status', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    selectionRows.length = 0;
    sessionUsers.clear();
    clearServerSelectionCache();
    clearUserServerFailures();
    clearUserListedNames();
    workspaceEnabled = true;
    cleanupAllServers();
    setServerInfosForTest([
      upstream('alpha'),
      upstream('beta'),
      upstream('off', { enabled: false }),
      upstream('hidden', { owner: 'nobody' } as Partial<ServerInfo>),
      upstream('ghost', { owner: 'nobody' } as Partial<ServerInfo>),
      personal('secret'),
      personal('solo'),
      personal('frozen', { enabled: false }),
    ]);
    for (const name of ['alpha', 'off', 'hidden', 'secret', 'frozen'])
      await setServerSelected('alice', name, true);
    for (const name of ['secret', 'solo', 'frozen']) seedListed('alice', name);
    mockCredentialStatus.mockResolvedValue({ configured: false });
    mockAcquire.mockImplementation(async (name: string) => {
      throw missingCredentialError(name);
    });
  });

  afterEach(() => {
    cleanupAllServers();
  });

  describe('a visible server that cannot be used', () => {
    it('answers needs_auth with the message, code and action, without reaching the upstream', async () => {
      const result = await call(alice, 'aggregate-session', 'secret::ping');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^'secret' needs your personal credentials/);
      expect(metaOf(result)).toEqual({ server: 'secret', code: 'needs_auth', action: 'connect' });
      expect(mockAcquire).not.toHaveBeenCalled();
      expect(callTools.secret).not.toHaveBeenCalled();
    });

    it('answers not_selected for an unselected server on the aggregate route', async () => {
      const result = await call(alice, 'aggregate-session', 'beta::ping');

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/^'beta' is not in your workspace/);
      expect(metaOf(result)).toEqual({ server: 'beta', code: 'not_selected', action: 'select' });
      expect(callTools.beta).not.toHaveBeenCalled();
    });

    it('answers not_selected on a single-server route and through $smart call_tool', async () => {
      const single = await call(alice, 'beta-session', 'ping');
      expect(metaOf(single)).toEqual({ server: 'beta', code: 'not_selected', action: 'select' });

      const smart = await as(alice, () =>
        handleCallToolRequest(
          { params: { name: 'call_tool', arguments: { toolName: 'beta::ping', arguments: {} } } },
          { sessionId: 'smart-session' },
        ),
      );
      expect(metaOf(smart)).toEqual({ server: 'beta', code: 'not_selected', action: 'select' });
      expect(callTools.beta).not.toHaveBeenCalled();
    });

    it('answers paused for a server the administrator turned off', async () => {
      const result = await call(alice, 'aggregate-session', 'off::ping');
      expect(metaOf(result)).toEqual({ server: 'off', code: 'paused', action: 'contact_admin' });
      expect(result.content[0].text).toMatch(/^'off' is paused/);
    });

    it('answers prompt gets and resource reads the same way', async () => {
      const prompt = await as(alice, () =>
        handleGetPromptRequest(
          { params: { name: 'beta::hello' } },
          { sessionId: 'aggregate-session' },
        ),
      );
      expect(prompt.isError).toBe(true);
      expect(metaOf(prompt)).toEqual({ server: 'beta', code: 'not_selected', action: 'select' });

      const resource = await as(alice, () =>
        handleReadResourceRequest(
          { params: { uri: 'test://beta' } },
          { sessionId: 'aggregate-session' },
        ),
      );
      expect(resource.contents[0].text).toMatch(/^'beta' is not in your workspace/);
      expect(metaOf(resource)).toEqual({ server: 'beta', code: 'not_selected', action: 'select' });
    });

    it('lets a usable server through untouched', async () => {
      const result = await call(alice, 'aggregate-session', 'alpha::ping');
      expect(result.content[0].text).toBe('alpha ok');
      expect(result._meta).toBeUndefined();
    });

    it('reports the failure of a personal runtime that cannot be prepared without its detail', async () => {
      mockCredentialStatus.mockResolvedValue({ configured: true });
      mockAcquire.mockRejectedValue(
        new UpstreamRequestError(
          "Upstream 'secret' connect failed: https://svc.test/mcp/SECRETPATH?token=SECRET123 status=500",
        ),
      );

      const result = await call(alice, 'aggregate-session', 'secret::ping');

      expect(result.isError).toBe(true);
      expect(metaOf(result)).toEqual({ server: 'secret', code: 'error', action: 'retry_later' });
      const text = JSON.stringify(result);
      expect(text).not.toContain('SECRET123');
      expect(text).not.toContain('svc.test');
    });
  });

  describe('a server the user cannot see', () => {
    // "ghost" is invisible and NOT selected, so only the visibility guard keeps it from
    // being reported as not_selected.
    it('keeps exactly the generic error, with no status', async () => {
      for (const name of ['ghost::ping', 'hidden::ping', 'nothere::ping']) {
        const result = await call(alice, 'aggregate-session', name);
        expect(result).toEqual({
          content: [{ type: 'text', text: GENERIC(name) }],
          isError: true,
        });
      }
    });

    it('is indistinguishable from a missing server on a single-server route and for prompts', async () => {
      const ghost = await call(alice, 'ghost-session', 'ping');
      const missing = await call(alice, 'missing-session', 'ping');
      expect(ghost).toEqual(missing);
      expect(metaOf(ghost)).toBeUndefined();

      const prompt = await as(alice, () =>
        handleGetPromptRequest(
          { params: { name: 'ghost::hello' } },
          { sessionId: 'aggregate-session' },
        ),
      );
      expect(prompt).toEqual({
        content: [{ type: 'text', text: 'Error: Prompt not available: ghost::hello' }],
        isError: true,
      });
    });

    it('does not reveal an invisible server through a resource URI', async () => {
      const read = (uri: string) =>
        as(alice, () =>
          handleReadResourceRequest({ params: { uri } }, { sessionId: 'aggregate-session' }),
        );
      const ghost = await read('test://ghost');
      const missing = await read('test://nothere');
      expect(metaOf(ghost)).toBeUndefined();
      expect(ghost.contents[0].text).toBe(missing.contents[0].text.replace('nothere', 'ghost'));
    });

    it('does not guess a visible server from a name prefix it does not expose', async () => {
      const result = await call(alice, 'aggregate-session', 'beta::nothing');
      expect(result).toEqual({
        content: [{ type: 'text', text: GENERIC('beta::nothing') }],
        isError: true,
      });
    });
  });

  describe('blocked calls', () => {
    it('leave the same audit trail as the generic failure, with the status as reason', async () => {
      const logged = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
      try {
        await call(alice, 'aggregate-session', 'beta::ping', {}, { a: 1 });

        expect(mockLogToolCall).toHaveBeenCalledTimes(1);
        expect(mockLogToolCall).toHaveBeenCalledWith(
          expect.objectContaining({
            server: 'beta',
            tool: 'ping',
            status: 'error',
            input: { a: 1 },
            errorMessage: expect.stringMatching(/\(reason: not_selected\)$/),
          }),
        );
        expect(logged).toHaveBeenCalledWith(
          'Error handling CallToolRequest',
          expect.objectContaining({ reason: 'not_selected', toolName: 'beta::ping' }),
        );
      } finally {
        logged.mockRestore();
      }
    });
  });

  describe('when the workspace setting is off', () => {
    beforeEach(() => {
      workspaceEnabled = false;
    });

    it('keeps the generic error for a missing server and does not gate unselected ones', async () => {
      expect((await call(alice, 'aggregate-session', 'beta::ping')).content[0].text).toBe(
        'beta ok',
      );
      expect(await call(alice, 'aggregate-session', 'nothere::ping')).toEqual({
        content: [{ type: 'text', text: GENERIC('nothere::ping') }],
        isError: true,
      });
    });

    it('keeps today’s missing-credential text and adds no status', async () => {
      const result = await call(alice, 'aggregate-session', 'secret::ping');
      expect(result).toEqual({ content: [{ type: 'text', text: MISSING_TEXT }], isError: true });
      expect(mockCredentialStatus).not.toHaveBeenCalled();
    });

    it('does not remember failures, annotate results or notify anyone', async () => {
      sessionUsers.set('alice-session', 'alice');
      const server = await getMcpServer('alice-session', '');
      const sent = jest.spyOn(server as any, 'sendToolListChanged').mockResolvedValue(undefined);
      mockAcquire.mockResolvedValue({
        release: jest.fn(),
        info: {
          ...leased('secret'),
          client: {
            callTool: jest.fn(async () => ({
              isError: true,
              content: [{ type: 'text', text: '{"error":"CREDENTIAL_INVALID"}' }],
            })),
          },
        },
      });

      const result = await call(alice, 'aggregate-session', 'secret::ping');

      expect(result.content).toEqual([{ type: 'text', text: '{"error":"CREDENTIAL_INVALID"}' }]);
      expect(result._meta).toBeUndefined();
      expect(getUserServerFailure('alice', 'secret')).toBeUndefined();
      expect(sent).not.toHaveBeenCalled();
    });
  });

  describe('failures from the upstream', () => {
    const CREDENTIAL_INVALID = { type: 'text', text: '{"error":"CREDENTIAL_INVALID"}' };
    const configuredWith = (callTool: jest.Mock<(...args: any[]) => Promise<any>>) => {
      mockCredentialStatus.mockResolvedValue({ configured: true });
      const info = leased('secret');
      (info.client as any).callTool = callTool;
      mockAcquire.mockResolvedValue({ release: jest.fn(), info });
    };

    it('keeps a structured CREDENTIAL_INVALID result and adds the status next to it', async () => {
      configuredWith(jest.fn(async () => ({ isError: true, content: [CREDENTIAL_INVALID] })));

      const result = await call(alice, 'aggregate-session', 'secret::ping');

      expect(result.isError).toBe(true);
      expect(result.content[0]).toEqual(CREDENTIAL_INVALID);
      expect(result.content[1].text).toMatch(/^Your credentials for 'secret' were rejected/);
      expect(metaOf(result)).toEqual({
        server: 'secret',
        code: 'credential_invalid',
        action: 'connect',
      });
      expect(getUserServerFailure('alice', 'secret')?.kind).toBe('auth');
    });

    it('treats CONNECTION_REVOKED the same way', async () => {
      configuredWith(
        jest.fn(async () => ({
          isError: true,
          content: [{ type: 'text', text: '{"error":"CONNECTION_REVOKED"}' }],
        })),
      );
      const result = await call(alice, 'aggregate-session', 'secret::ping');
      expect(metaOf(result)?.code).toBe('credential_invalid');
    });

    it('does not remember a rejected credential past the next success', async () => {
      const callTool = jest.fn<(...args: any[]) => Promise<any>>();
      callTool.mockResolvedValueOnce({ isError: true, content: [CREDENTIAL_INVALID] });
      callTool.mockResolvedValue({ content: [{ type: 'text', text: 'fine now' }] });
      configuredWith(callTool);

      await call(alice, 'aggregate-session', 'secret::ping');
      // The state describes the last attempt, so the next call is still tried.
      const healed = await call(alice, 'aggregate-session', 'secret::ping');
      expect(healed.content[0].text).toBe('fine now');
      expect(healed._meta).toBeUndefined();
      expect(getUserServerFailure('alice', 'secret')).toBeUndefined();
    });

    it.each([
      ['an OpenAPI 403', new Error('API call failed: 403 Forbidden {"message":"no access"}')],
      ['a 401 in the message', new Error('Order 401 not found')],
      ['an error carrying status 401', Object.assign(new Error('boom'), { status: 401 })],
    ])('never turns %s into a rejected credential or rewrites the result', async (_n, error) => {
      configuredWith(jest.fn(async () => Promise.reject(error)));

      const result = await call(alice, 'aggregate-session', 'secret::ping');

      expect(result._meta).toBeUndefined();
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toContain(error.message);
      expect(getUserServerFailure('alice', 'secret')).toBeUndefined();
    });

    it('leaves a tool’s own error result untouched', async () => {
      configuredWith(
        jest.fn(async () => ({
          isError: true,
          content: [{ type: 'text', text: 'Order 401 not found' }],
        })),
      );
      const result = await call(alice, 'aggregate-session', 'secret::ping');
      expect(result).toEqual({
        isError: true,
        content: [{ type: 'text', text: 'Order 401 not found' }],
      });
      expect(getUserServerFailure('alice', 'secret')).toBeUndefined();
    });

    it('decides from each call’s own outcome when calls run concurrently', async () => {
      configuredWith(
        jest.fn(async (params: any) =>
          params.arguments?.mode === 'revoked'
            ? { isError: true, content: [CREDENTIAL_INVALID] }
            : { isError: true, content: [{ type: 'text', text: 'bad input' }] },
        ),
      );

      const [revoked, ordinary] = await Promise.all([
        call(alice, 'aggregate-session', 'secret::ping', {}, { mode: 'revoked' }),
        call(alice, 'aggregate-session', 'secret::ping', {}, { mode: 'other' }),
      ]);

      expect(metaOf(revoked)?.code).toBe('credential_invalid');
      expect(ordinary).toEqual({ isError: true, content: [{ type: 'text', text: 'bad input' }] });
    });

    it('keeps one user’s failure from touching another user', async () => {
      configuredWith(jest.fn(async () => ({ isError: true, content: [CREDENTIAL_INVALID] })));
      await setServerSelected('bob', 'secret', true);
      await call(alice, 'aggregate-session', 'secret::ping');

      expect(getUserServerFailure('alice', 'secret')).toBeDefined();
      expect(getUserServerFailure('bob', 'secret')).toBeUndefined();
    });

    it('forgets a failure when the user’s credentials change', async () => {
      configuredWith(jest.fn(async () => ({ isError: true, content: [CREDENTIAL_INVALID] })));
      await call(alice, 'aggregate-session', 'secret::ping');

      credentialBindingEvents.emit('invalidate', { serverName: 'secret', username: 'bob' });
      expect(getUserServerFailure('alice', 'secret')).toBeDefined();
      credentialBindingEvents.emit('invalidate', { serverName: 'secret', username: 'alice' });
      expect(getUserServerFailure('alice', 'secret')).toBeUndefined();
    });

    it('clears a stale failure on a success through an admin group route', async () => {
      recordUserServerFailure('alice', 'alpha', 'runtime');
      recordUserServerFailure('alice', 'beta', 'runtime');

      const result = await call(alice, 'team-session', 'alpha::ping');

      expect(result.content[0].text).toBe('alpha ok');
      expect(getUserServerFailure('alice', 'alpha')).toBeUndefined();
      expect(getUserServerFailure('alice', 'beta')).toBeDefined();
    });

    it('sends no list notifications when availability flips', async () => {
      sessionUsers.set('alice-session', 'alice');
      const server = await getMcpServer('alice-session', '');
      const sent = ['sendToolListChanged', 'sendPromptListChanged', 'sendResourceListChanged'].map(
        (method) => jest.spyOn(server as any, method).mockResolvedValue(undefined),
      );
      configuredWith(jest.fn(async () => ({ isError: true, content: [CREDENTIAL_INVALID] })));

      await call(alice, 'aggregate-session', 'secret::ping');
      configuredWith(jest.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })));
      await call(alice, 'aggregate-session', 'secret::ping');

      for (const spy of sent) expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('personal servers without shared cached lists', () => {
    it('names a personal server the user previously listed, whatever its state', async () => {
      const unselected = await call(alice, 'aggregate-session', 'solo::ping');
      expect(metaOf(unselected)).toEqual({
        server: 'solo',
        code: 'not_selected',
        action: 'select',
      });
      const paused = await call(alice, 'aggregate-session', 'frozen::ping');
      expect(metaOf(paused)).toEqual({ server: 'frozen', code: 'paused', action: 'contact_admin' });
      const prompt = await as(alice, () =>
        handleGetPromptRequest(
          { params: { name: 'solo::hello' } },
          { sessionId: 'aggregate-session' },
        ),
      );
      expect(metaOf(prompt)?.code).toBe('not_selected');
      const resource = await as(alice, () =>
        handleReadResourceRequest(
          { params: { uri: 'test://solo' } },
          { sessionId: 'aggregate-session' },
        ),
      );
      expect(metaOf(resource)?.code).toBe('not_selected');
    });

    it('keeps the generic error on the aggregate route for a name the user never listed', async () => {
      clearUserListedNames();
      for (const name of ['solo::ping', 'frozen::ping'])
        expect(await call(alice, 'aggregate-session', name)).toEqual({
          content: [{ type: 'text', text: GENERIC(name) }],
          isError: true,
        });
    });

    it('still explains a selected personal server while its runtime is prepared', async () => {
      clearUserListedNames();
      const result = await call(alice, 'aggregate-session', 'secret::ping');
      expect(metaOf(result)?.code).toBe('needs_auth');
    });

    it('still reports the status on the single-server route of a never-connected user', async () => {
      clearUserListedNames();
      const result = await call(alice, 'solo-session', 'ping');
      expect(metaOf(result)).toEqual({ server: 'solo', code: 'not_selected', action: 'select' });
    });

    it('never uses another user’s listed names', async () => {
      clearUserListedNames();
      seedListed('bob', 'solo');
      expect(await call(alice, 'aggregate-session', 'solo::ping')).toEqual({
        content: [{ type: 'text', text: GENERIC('solo::ping') }],
        isError: true,
      });
      expect(metaOf(await call(bob, 'aggregate-session', 'solo::ping'))?.code).toBe('not_selected');
    });

    it('records the names while the user’s own runtime is listed, and forgets them with the credentials', async () => {
      clearUserListedNames();
      mockCredentialStatus.mockResolvedValue({ configured: true });
      mockAcquire.mockResolvedValue({ release: jest.fn(), info: leased('secret') });
      await as(alice, () => handleListToolsRequest({}, { sessionId: 'aggregate-session' }));
      await setServerSelected('alice', 'secret', false);

      expect(metaOf(await call(alice, 'aggregate-session', 'secret::ping'))?.code).toBe(
        'not_selected',
      );

      credentialBindingEvents.emit('invalidate', { serverName: 'secret', username: 'alice' });
      expect((await call(alice, 'aggregate-session', 'secret::ping')).content[0].text).toBe(
        GENERIC('secret::ping'),
      );
    });

    it('leaves the same audit entry when needs_auth is discovered while preparing the runtime', async () => {
      mockCredentialStatus.mockResolvedValueOnce({ configured: true });
      mockCredentialStatus.mockResolvedValue({ configured: false });

      const result = await call(alice, 'aggregate-session', 'secret::ping', {}, { a: 1 });

      expect(metaOf(result)?.code).toBe('needs_auth');
      expect(mockLogToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'secret',
          status: 'error',
          input: { a: 1 },
          errorMessage: expect.stringMatching(/\(reason: needs_auth\)$/),
        }),
      );
    });
  });

  describe('structured credential codes on a shared server', () => {
    it('are an ordinary tool result: untouched and not remembered', async () => {
      const original = {
        isError: true,
        content: [{ type: 'text', text: '{"error":"CREDENTIAL_INVALID"}' }],
      };
      callTools.alpha.mockResolvedValue(original);

      const result = await call(alice, 'aggregate-session', 'alpha::ping');

      expect(result).toEqual(original);
      expect(getUserServerFailure('alice', 'alpha')).toBeUndefined();
    });
  });

  describe('a refusal that several users share', () => {
    it('is the server’s misconfiguration once a second user is refused', async () => {
      await setServerSelected('bob', 'secret', true);
      seedListed('bob', 'secret');
      mockCredentialStatus.mockResolvedValue({ configured: true });
      mockAcquire.mockRejectedValue(
        createUpstreamRequestError('secret', 'connect', { status: 401 }, {}),
      );

      const first = await call(alice, 'aggregate-session', 'secret::ping');
      expect(metaOf(first)?.code).toBe('credential_invalid');

      const second = await call(bob, 'aggregate-session', 'secret::ping');
      expect(metaOf(second)).toEqual({ server: 'secret', code: 'error', action: 'contact_admin' });
      expect(getUserServerFailure('alice', 'secret')?.kind).toBe('misconfigured');
      expect(getUserServerFailure('bob', 'secret')?.kind).toBe('misconfigured');
    });
  });

  describe('failures to prepare a personal runtime', () => {
    const prepareFails = (error: unknown) => {
      mockCredentialStatus.mockResolvedValue({ configured: true });
      mockAcquire.mockRejectedValue(error);
    };

    it('reports credential_invalid for a transport-level 401 and returns only the status', async () => {
      prepareFails(
        createUpstreamRequestError('secret', 'connect', { status: 401, message: 'nope' }, {}),
      );
      const result = await call(alice, 'aggregate-session', 'secret::ping');
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text).toMatch(/^Your credentials for 'secret' were rejected/);
      expect(metaOf(result)).toEqual({
        server: 'secret',
        code: 'credential_invalid',
        action: 'connect',
      });
    });

    it('does not treat a 403 at connection time as a rejected credential', async () => {
      prepareFails(
        createUpstreamRequestError('secret', 'connect', { status: 403, message: 'no' }, {}),
      );
      const result = await call(alice, 'aggregate-session', 'secret::ping');
      expect(metaOf(result)).toEqual({ server: 'secret', code: 'error', action: 'retry_later' });
    });

    it('reports a binding that changed mid-request as a retryable error', async () => {
      prepareFails(new CredentialBindingConflictError('Personal authorization changed; reconnect'));
      const result = await call(alice, 'aggregate-session', 'secret::ping');
      expect(metaOf(result)).toEqual({ server: 'secret', code: 'error', action: 'retry_later' });
    });

    it('sends a broken credential store to the administrator', async () => {
      prepareFails(new CredentialBindingConfigError('Invalid encryption key'));
      const result = await call(alice, 'aggregate-session', 'secret::ping');
      expect(metaOf(result)).toEqual({ server: 'secret', code: 'error', action: 'contact_admin' });
      expect(JSON.stringify(result)).not.toContain('encryption');
    });

    it('sends an invalid server template to the administrator', async () => {
      prepareFails(new CredentialBindingError('Invalid URL credential template'));
      const result = await call(alice, 'aggregate-session', 'secret::ping');
      expect(metaOf(result)).toEqual({ server: 'secret', code: 'error', action: 'contact_admin' });
    });

    it('does not remember a missing binding as a failure', async () => {
      mockCredentialStatus.mockResolvedValue({ configured: true });
      mockAcquire.mockRejectedValue(missingCredentialError('secret'));
      await call(alice, 'aggregate-session', 'secret::ping');
      expect(getUserServerFailure('alice', 'secret')).toBeUndefined();
    });
  });
});
