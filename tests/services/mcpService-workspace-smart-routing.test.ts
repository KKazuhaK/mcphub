import { jest } from '@jest/globals';
/**
 * Runs the real smartRoutingService against the workspace selection scope, so the
 * server set it searches and describes comes from mcpService's own visibility.
 */
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
  'smart-session': '$smart',
  'smart-team-session': '$smart/team',
};

jest.mock('../../src/services/sseService.js', () => ({
  getGroup: jest.fn((sessionId: string) => sessionGroups[sessionId]),
  getSessionUsername: jest.fn((sessionId: string) => sessionUsers.get(sessionId)),
}));

const mockSearchToolsByVector = jest.fn<(...args: any[]) => Promise<any[]>>();
jest.mock('../../src/utils/smartRouting.js', () => ({
  getSmartRoutingConfig: jest.fn(async () => ({ progressiveDisclosure: true })),
}));
jest.mock('../../src/services/groupService.js', () => ({
  getGroupServerExposedName: jest.fn((config: any) => config.alias || config.name),
  getServerConfigsInGroup: jest.fn(async (group: string) =>
    group === 'team' ? teamGroup.servers : [],
  ),
  getServersInGroup: jest.fn(async (group: string) =>
    group === 'team' ? ['alpha', 'beta', 'gamma'] : [],
  ),
  getServerConfigInGroup: jest.fn(),
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
  searchToolsByVector: (...args: unknown[]) => mockSearchToolsByVector(...(args as [])),
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

import {
  cleanupAllServers,
  handleCallToolRequest,
  initUpstreamServers,
  setServerInfosForTest,
} from '../../src/services/mcpService.js';
import { UserContextService } from '../../src/services/userContextService.js';
import {
  clearServerSelectionCache,
  setServerSelected,
} from '../../src/services/userServerSelectionService.js';

const upstream = (name: string): ServerInfo =>
  ({
    name,
    status: 'connected',
    enabled: true,
    tools: [{ name: `${name}::ping`, description: 'Ping', inputSchema: { type: 'object' } }],
    prompts: [],
    resources: [],
    client: { callTool: jest.fn() },
    options: {},
  }) as unknown as ServerInfo;

const alice = { username: 'alice', password: '', isAdmin: false } as IUser;
const bob = { username: 'bob', password: '', isAdmin: false } as IUser;

const as = <T>(user: IUser | null, fn: () => Promise<T>) =>
  UserContextService.getInstance().runWithContext(fn, user);

const metaTool = async (user: IUser | null, sessionId: string, name: string, args: object) => {
  const result = await as(user, () =>
    handleCallToolRequest({ params: { name, arguments: args } }, { sessionId }),
  );
  return result.content[0].text as string;
};

const searched = async (user: IUser | null, sessionId: string) => {
  const text = await metaTool(user, sessionId, 'search_tools', { query: 'ping' });
  return (JSON.parse(text).tools as Array<{ name: string }>).map((tool) => tool.name).sort();
};

describe('workspace selection with the real smart routing service', () => {
  beforeAll(async () => {
    await initUpstreamServers();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    selectionRows.length = 0;
    clearServerSelectionCache();
    workspaceEnabled = true;
    cleanupAllServers();
    setServerInfosForTest([upstream('alpha'), upstream('beta'), upstream('gamma')]);
    await setServerSelected('alice', 'alpha', true);
    await setServerSelected('alice', 'gamma', true);
    await setServerSelected('bob', 'beta', true);
    // The vector index covers every server; only the servers passed in may match.
    mockSearchToolsByVector.mockImplementation(async (_query, _limit, _threshold, servers) =>
      (servers as string[]).map((serverName) => ({
        serverName,
        toolName: `${serverName}::ping`,
        description: 'Ping',
        inputSchema: {},
        similarity: 0.9,
        toolSimilarity: 0.9,
        searchableText: 'ping',
      })),
    );
  });

  afterEach(() => cleanupAllServers());

  it('searches only the servers the user selected', async () => {
    expect(await searched(alice, 'smart-session')).toEqual(['alpha::ping', 'gamma::ping']);
    expect(await searched(bob, 'smart-session')).toEqual(['beta::ping']);
    expect(mockSearchToolsByVector.mock.calls.map((call) => call[3])).toEqual([
      ['alpha', 'gamma'],
      ['beta'],
    ]);
  });

  it('describes only tools of selected servers', async () => {
    const own = await metaTool(alice, 'smart-session', 'describe_tool', {
      toolName: 'alpha::ping',
    });
    expect(own).toContain('alpha::ping');
    const other = await metaTool(alice, 'smart-session', 'describe_tool', {
      toolName: 'beta::ping',
    });
    expect(other).not.toContain('"name":"beta::ping"');
    expect(other.toLowerCase()).toContain('not');
  });

  it('keeps admin-defined group scopes and userless requests unchanged', async () => {
    expect(await searched(alice, 'smart-team-session')).toEqual([
      'alpha::ping',
      'beta::ping',
      'gamma::ping',
    ]);
    expect(await searched(null, 'smart-session')).toEqual([
      'alpha::ping',
      'beta::ping',
      'gamma::ping',
    ]);
  });

  it('applies no filtering when the setting is off', async () => {
    workspaceEnabled = false;
    expect(await searched(alice, 'smart-session')).toHaveLength(3);
  });
});
