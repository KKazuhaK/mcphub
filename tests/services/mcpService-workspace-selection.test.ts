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

jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: jest.fn(() => ({ logToolCall: jest.fn(async () => undefined) })),
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

import {
  cleanupAllServers,
  getMcpServer,
  handleCallToolRequest,
  handleGetPromptRequest,
  handleListPromptsRequest,
  handleListResourcesRequest,
  handleListResourceTemplatesRequest,
  handleReadResourceRequest,
  handleListToolsRequest,
  initUpstreamServers,
  removeServer,
  notifyUserListsChanged,
  setServerInfosForTest,
} from '../../src/services/mcpService.js';
import { UserContextService } from '../../src/services/userContextService.js';
import {
  clearServerSelectionCache,
  setServerSelected,
} from '../../src/services/userServerSelectionService.js';

const callTools: Record<string, jest.Mock> = {};

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
      listResourceTemplates: jest.fn(async () => ({
        resourceTemplates: [{ name: `${name}-tpl`, uriTemplate: `${name}://{id}` }],
      })),
    },
    options: {},
    ...extra,
  } as unknown as ServerInfo;
};

const alice = { username: 'alice', password: '', isAdmin: false } as IUser;
const bob = { username: 'bob', password: '', isAdmin: false } as IUser;

const as = <T>(user: IUser | null, fn: () => Promise<T>) =>
  UserContextService.getInstance().runWithContext(fn, user);

const select = async (username: string, ...serverNames: string[]) => {
  for (const serverName of serverNames) await setServerSelected(username, serverName, true);
};

const toolNames = async (user: IUser | null, sessionId: string) =>
  (await as(user, () => handleListToolsRequest({}, { sessionId }))).tools
    .map((tool: { name: string }) => tool.name)
    .sort();

const call = (user: IUser | null, sessionId: string, name: string, extra: object = {}) =>
  as(user, () =>
    handleCallToolRequest({ params: { name, arguments: {} } }, { sessionId, ...extra }),
  );

describe('mcpService workspace selection', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    selectionRows.length = 0;
    sessionUsers.clear();
    clearServerSelectionCache();
    workspaceEnabled = true;
    cleanupAllServers();
    setServerInfosForTest([
      upstream('alpha'),
      upstream('beta'),
      upstream('gamma'),
      upstream('hidden', { owner: 'nobody' } as Partial<ServerInfo>),
    ]);
    await select('alice', 'alpha', 'gamma', 'hidden');
    await select('bob', 'beta');
    mockSelectionDao.save.mockClear();
    mockSelectionDao.listByUsername.mockClear();
  });

  afterEach(() => {
    cleanupAllServers();
  });

  it('applies no filtering when the setting is off', async () => {
    workspaceEnabled = false;
    expect(await toolNames(alice, 'aggregate-session')).toEqual([
      'alpha::ping',
      'beta::ping',
      'gamma::ping',
    ]);
    const result = await call(alice, 'aggregate-session', 'beta::ping');
    expect(result.isError).toBeFalsy();
    expect(callTools.beta).toHaveBeenCalledTimes(1);
    expect(mockSelectionDao.listByUsername).not.toHaveBeenCalled();
  });

  it('lists only each user’s own selection on the aggregate route', async () => {
    // "hidden" is selected by alice but not visible to her.
    expect(await toolNames(alice, 'aggregate-session')).toEqual(['alpha::ping', 'gamma::ping']);
    expect(await toolNames(bob, 'aggregate-session')).toEqual(['beta::ping']);
    expect(await toolNames({ ...bob, username: 'carol' }, 'aggregate-session')).toEqual([]);
  });

  it('filters prompts and resources the same way', async () => {
    const prompts = await as(alice, () =>
      handleListPromptsRequest({}, { sessionId: 'aggregate-session' }),
    );
    expect(prompts.prompts.map((prompt: { name: string }) => prompt.name).sort()).toEqual([
      'alpha::hello',
      'gamma::hello',
    ]);
    const resources = await as(bob, () =>
      handleListResourcesRequest({}, { sessionId: 'aggregate-session' }),
    );
    expect(resources.resources.map((resource: { uri: string }) => resource.uri)).toEqual([
      'test://beta',
    ]);
    const allowed = await as(alice, () =>
      handleGetPromptRequest(
        { params: { name: 'alpha::hello' } },
        { sessionId: 'aggregate-session' },
      ),
    );
    expect(allowed.isError).toBeUndefined();
    const denied = await as(alice, () =>
      handleGetPromptRequest(
        { params: { name: 'beta::hello' } },
        { sessionId: 'aggregate-session' },
      ),
    );
    expect(denied.isError).toBe(true);
  });

  it('reads resources and lists templates only for selected servers', async () => {
    const read = (user: IUser, uri: string, extra: object = { sessionId: 'aggregate-session' }) =>
      as(user, () => handleReadResourceRequest({ params: { uri } }, extra));

    const allowed = await read(alice, 'test://alpha');
    expect(allowed.contents[0].text).toBe('alpha');
    const denied = await read(alice, 'test://beta');
    expect(JSON.stringify(denied)).not.toContain('"text":"beta"');

    const templates = await as(alice, () =>
      handleListResourceTemplatesRequest({}, { sessionId: 'aggregate-session' }),
    );
    expect(
      templates.resourceTemplates.map((template: { name: string }) => template.name).sort(),
    ).toEqual(['alpha-tpl', 'gamma-tpl']);
  });

  it('leaves dashboard-originated calls alone', async () => {
    const result = await as(alice, () =>
      handleReadResourceRequest({ params: { uri: 'test://beta' } }, { dashboard: true }),
    );
    expect(result.contents[0].text).toBe('beta');
  });

  it('rejects calls to an unselected server through the aggregate route', async () => {
    const denied = await call(alice, 'aggregate-session', 'beta::ping');
    expect(denied.isError).toBe(true);
    expect(callTools.beta).not.toHaveBeenCalled();

    const allowed = await call(alice, 'aggregate-session', 'alpha::ping');
    expect(allowed.isError).toBeFalsy();
    expect(callTools.alpha).toHaveBeenCalledTimes(1);
  });

  it('exposes nothing and rejects calls on the single-server route of an unselected server', async () => {
    expect(await toolNames(alice, 'beta-session')).toEqual([]);
    const denied = await call(alice, 'beta-session', 'ping');
    expect(denied.isError).toBe(true);
    expect(callTools.beta).not.toHaveBeenCalled();

    expect(await toolNames(alice, 'alpha-session')).toEqual(['ping']);
    expect((await call(alice, 'alpha-session', 'ping')).isError).toBeFalsy();
    expect(callTools.alpha).toHaveBeenCalledTimes(1);

    // Control: the same route works for a user who selected the server.
    expect(await toolNames(bob, 'beta-session')).toEqual(['ping']);
    expect((await call(bob, 'beta-session', 'ping')).isError).toBeFalsy();
  });

  it('does not describe an unselected server when a session is created for its route', async () => {
    const selected = await as(alice, () => getMcpServer(undefined, 'alpha'));
    const unselected = await as(alice, () => getMcpServer(undefined, 'beta'));
    expect((selected as any)._serverInfo.name).toBe('alpha');
    expect((unselected as any)._serverInfo.name).not.toBe('beta');
  });

  it('restricts the global $smart scope but not group routes or userless requests', async () => {
    await initUpstreamServers();
    setServerInfosForTest([upstream('alpha'), upstream('beta'), upstream('gamma')]);
    const visibleToSmartRouting = mockInitSmartRoutingService.mock
      .calls[0][0] as () => ServerInfo[];
    mockHandleSearchToolsRequest.mockImplementation(async () => ({
      content: [
        {
          type: 'text',
          text: visibleToSmartRouting()
            .map((info) => info.name)
            .join(','),
        },
      ],
    }));
    const searchedServers = async (user: IUser | null, sessionId: string) =>
      (
        await as(user, () =>
          handleCallToolRequest(
            { params: { name: 'search_tools', arguments: { query: 'ping' } } },
            { sessionId },
          ),
        )
      ).content[0].text;

    expect(await searchedServers(alice, 'smart-session')).toBe('alpha,gamma');
    expect(await searchedServers(bob, 'smart-session')).toBe('beta');
    // Admin-defined group routes keep their behaviour.
    expect(await searchedServers(alice, 'smart-team-session')).toBe('alpha,beta,gamma');
    expect(await toolNames(alice, 'team-session')).toEqual([
      'alpha::ping',
      'beta::ping',
      'gamma::ping',
    ]);
    expect((await call(alice, 'team-session', 'beta::ping')).isError).toBeFalsy();
    // No authenticated user (system key, skipAuth) is exempt.
    expect(await searchedServers(null, 'smart-session')).toBe('alpha,beta,gamma');
    expect(await toolNames(null, 'aggregate-session')).toHaveLength(3);
  });

  it('rejects call_tool for an unselected server under $smart', async () => {
    const denied = await as(alice, () =>
      handleCallToolRequest(
        { params: { name: 'call_tool', arguments: { toolName: 'beta::ping', arguments: {} } } },
        { sessionId: 'smart-session' },
      ),
    );
    expect(denied.isError).toBe(true);
    expect(callTools.beta).not.toHaveBeenCalled();
  });

  it('leaves explicit REST targets alone', async () => {
    const result = await as(alice, () =>
      handleCallToolRequest(
        { params: { name: 'call_tool', arguments: { toolName: 'beta::ping', arguments: {} } } },
        { sessionId: 'api-session', server: 'beta' },
      ),
    );
    expect(result.isError).toBeFalsy();
    expect(callTools.beta).toHaveBeenCalledTimes(1);
  });

  it('serves repeated lists from the cache and picks up writes', async () => {
    await toolNames(alice, 'aggregate-session');
    await toolNames(alice, 'aggregate-session');
    expect(mockSelectionDao.listByUsername).toHaveBeenCalledTimes(1);

    await setServerSelected('alice', 'beta', true);
    expect(await toolNames(alice, 'aggregate-session')).toEqual([
      'alpha::ping',
      'beta::ping',
      'gamma::ping',
    ]);
    await setServerSelected('alice', 'alpha', false);
    expect(await toolNames(alice, 'aggregate-session')).toEqual(['beta::ping', 'gamma::ping']);
  });

  it('removes the selections of a deleted server for every user', async () => {
    await removeServer('beta');

    expect(mockSelectionDao.delete).toHaveBeenCalledWith({ serverName: 'beta' });
  });

  it('notifies only the sessions of the user whose selection changed', async () => {
    sessionUsers.set('alice-session', 'alice');
    sessionUsers.set('bob-session', 'bob');
    const notified: string[] = [];
    for (const sessionId of ['alice-session', 'bob-session']) {
      const server = await getMcpServer(sessionId, '');
      for (const method of [
        'sendToolListChanged',
        'sendPromptListChanged',
        'sendResourceListChanged',
      ]) {
        jest.spyOn(server as any, method).mockImplementation(async () => {
          notified.push(`${sessionId}:${method}`);
        });
      }
    }

    notifyUserListsChanged('alice');

    expect(notified.sort()).toEqual([
      'alice-session:sendPromptListChanged',
      'alice-session:sendResourceListChanged',
      'alice-session:sendToolListChanged',
    ]);
  });
});
