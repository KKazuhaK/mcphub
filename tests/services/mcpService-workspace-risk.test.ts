import { jest } from '@jest/globals';
/**
 * Tool risk levels under Workspace Mode: the user's own ceiling (selection routes only), the
 * administrator's cap (every route, administrators exempt), lists, $smart search / describe /
 * pinned tools, calls and the shape of each refusal. Runs the real smart routing service.
 */
import type { IGroup, IUser, ServerConfig, ServerInfo } from '../../src/types/index.js';

const teamGroup: IGroup = {
  id: 'group-1',
  name: 'team',
  owner: 'admin',
  servers: ['alpha', 'beta'].map((name) => ({
    name,
    tools: 'all',
    prompts: 'all',
    resources: 'all',
  })),
};
const pinGroup: IGroup = {
  id: 'group-2',
  name: 'pin',
  owner: 'admin',
  servers: [
    { name: 'alpha', tools: 'all', prompts: 'all', resources: 'all', pinnedTools: ['get', 'send'] },
  ],
};
const groups = [teamGroup, pinGroup];

const mockGroupDao = {
  findAll: jest.fn(async () => groups),
  findByName: jest.fn(async (name: string) => groups.find((g) => g.name === name) ?? null),
  findById: jest.fn(async (id: string) => groups.find((g) => g.id === id) ?? null),
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

type Row = {
  username: string;
  serverName: string;
  selected: boolean;
  riskCeiling?: 'read' | 'write' | 'external';
  updatedAt: string;
};
const selectionRows: Row[] = [];
const mockSelectionDao = {
  listByUsername: jest.fn(async (username: string) =>
    selectionRows.filter((row) => row.username === username),
  ),
  save: jest.fn(async (selection: Row) => {
    const index = selectionRows.findIndex(
      (row) => row.username === selection.username && row.serverName === selection.serverName,
    );
    const previous = index >= 0 ? selectionRows.splice(index, 1)[0] : undefined;
    selectionRows.push({
      ...selection,
      ...((selection.riskCeiling ?? previous?.riskCeiling)
        ? { riskCeiling: selection.riskCeiling ?? previous?.riskCeiling }
        : {}),
    });
  }),
  saveRiskCeiling: jest.fn(
    async (username: string, serverName: string, riskCeiling: Row['riskCeiling'], at: string) => {
      const index = selectionRows.findIndex(
        (row) => row.username === username && row.serverName === serverName,
      );
      const previous = index >= 0 ? selectionRows.splice(index, 1)[0] : undefined;
      selectionRows.push({
        selected: false,
        ...previous,
        username,
        serverName,
        riskCeiling,
        updatedAt: at,
      });
    },
  ),
  delete: jest.fn(async () => undefined),
  renameServer: jest.fn(async () => undefined),
};

let workspaceEnabled = true;
const sessionUsers = new Map<string, string>();

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getActivityDao: jest.fn(() => ({ create: (...args: any[]) => mockActivityCreate(...args) })),
  isActivityLoggingEnabled: jest.fn(() => true),
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

jest.mock('../../src/services/services.js', () => ({
  getDataService: jest.fn(() => ({
    filterData: (data: any[]) => data.filter((item) => item.owner !== 'nobody'),
  })),
}));

const sessionGroups: Record<string, string> = {
  'aggregate-session': '',
  'alpha-session': 'alpha',
  'team-session': 'team',
  'smart-session': '$smart',
  'smart-team-session': '$smart/team',
  'smart-pin-session': '$smart/pin',
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
  normalizeGroupServers: jest.fn((servers: any[]) =>
    servers.map((server) => (typeof server === 'string' ? { name: server } : server)),
  ),
  getGroupServerExposedName: jest.fn((config: any) => config.alias || config.name),
  getServerConfigsInGroup: jest.fn(
    async (group: string) => groups.find((g) => g.name === group)?.servers ?? [],
  ),
  getServersInGroup: jest.fn(async (group: string) =>
    (groups.find((g) => g.name === group)?.servers ?? []).map((s: any) => s.name),
  ),
  getServerConfigInGroup: jest.fn(async (group: string, server: string) =>
    (groups.find((g) => g.name === group)?.servers ?? []).find((s: any) => s.name === server),
  ),
}));

// Records every call; with `useRealActivityLogger` it also runs the real service, so the stored
// row can be compared with the one of a call to a tool that does not exist.
const mockLogToolCall = jest.fn<(...args: any[]) => Promise<void>>(async () => undefined);
const mockActivityCreate = jest.fn<(...args: any[]) => Promise<void>>(async () => undefined);
let useRealActivityLogger = false;
jest.mock('../../src/services/activityLoggingService.js', () => {
  const actual = jest.requireActual('../../src/services/activityLoggingService.js') as any;
  return {
    ...actual,
    getActivityLoggingService: jest.fn(() => ({
      logToolCall: (...args: any[]) => {
        mockLogToolCall(...args);
        return useRealActivityLogger
          ? actual.getActivityLoggingService().logToolCall(...args)
          : Promise.resolve();
      },
    })),
  };
});

// Annotations are believed for servers an administrator owns (no owner counts as one).
const nonAdminOwners = new Set(['mallory']);
jest.mock('../../src/services/annotationTrustService.js', () => ({
  primeAnnotationTrust: async () => undefined,
  areAnnotationsTrusted: (owner?: string) => !owner || !nonAdminOwners.has(owner),
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
  getServerByName,
  getServersInfo,
  handleCallToolRequest,
  handleListToolsRequest,
  initUpstreamServers,
  setServerInfosForTest,
} from '../../src/services/mcpService.js';
import { UserContextService } from '../../src/services/userContextService.js';
import { classifyActivity } from '../../src/services/workspaceActivityService.js';
import {
  clearServerSelectionCache,
  setServerRiskCeiling,
  setServerSelected,
} from '../../src/services/userServerSelectionService.js';

const callTools: Record<string, jest.Mock<(...args: any[]) => Promise<any>>> = {};

// get: read-only. edit: not read-only, closed world (own data). send: no annotations.
const toolsOf = (name: string, withSend = true) => [
  {
    name: `${name}::get`,
    description: 'Get',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true },
  },
  {
    name: `${name}::edit`,
    description: 'Edit',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: false, openWorldHint: false },
  },
  ...(withSend
    ? [{ name: `${name}::send`, description: 'Send', inputSchema: { type: 'object' } }]
    : []),
];

const upstream = (
  name: string,
  config: Partial<ServerConfig> = {},
  withSend = true,
): ServerInfo => {
  callTools[name] = jest.fn(async () => ({ content: [{ type: 'text', text: `${name} ok` }] }));
  return {
    name,
    status: 'connected',
    enabled: true,
    config,
    tools: toolsOf(name, withSend),
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
const admin = { username: 'root', password: '', isAdmin: true } as IUser;

const as = <T>(user: IUser | null, fn: () => Promise<T>) =>
  UserContextService.getInstance().runWithContext(fn, user);

const call = (user: IUser | null, name: string, sessionId = 'aggregate-session', extra = {}) =>
  as(user, () =>
    handleCallToolRequest({ params: { name, arguments: {} } }, { sessionId, ...extra }),
  );

const names = async (user: IUser | null, sessionId = 'aggregate-session') =>
  (await as(user, () => handleListToolsRequest({}, { sessionId }))).tools
    .map((tool: { name: string }) => tool.name)
    .sort();

const metaTool = async (user: IUser | null, sessionId: string, name: string, args: object) =>
  as(user, () => handleCallToolRequest({ params: { name, arguments: args } }, { sessionId }));

const searched = async (user: IUser | null, sessionId = 'smart-session') => {
  const result = await metaTool(user, sessionId, 'search_tools', { query: 'x' });
  return (JSON.parse(result.content[0].text).tools as Array<{ name: string }>)
    .map((tool) => tool.name)
    .sort();
};

const metaOf = (result: any) => result._meta?.['mcphub/status'];
const READ = ['alpha::get'];
const WRITE = ['alpha::edit', 'alpha::get'];
const ALL = ['alpha::edit', 'alpha::get', 'alpha::send'];

describe('mcpService workspace tool risk levels', () => {
  const load = (alphaConfig: Partial<ServerConfig> = {}, withSend = true) =>
    setServerInfosForTest([upstream('alpha', alphaConfig, withSend), upstream('beta')]);

  beforeAll(async () => {
    await initUpstreamServers();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    selectionRows.length = 0;
    sessionUsers.clear();
    clearServerSelectionCache();
    workspaceEnabled = true;
    (mockServerDao.findAll as jest.Mock<any>).mockResolvedValue([]);
    cleanupAllServers();
    for (const user of ['alice', 'bob', 'root']) await setServerSelected(user, 'alpha', true);
    mockSearchToolsByVector.mockImplementation(async (_query, _limit, _threshold, servers) =>
      (servers as string[]).flatMap((serverName) =>
        ['get', 'edit', 'send'].map((tool) => ({
          serverName,
          toolName: `${serverName}::${tool}`,
          description: tool,
          inputSchema: {},
          similarity: 0.9,
          toolSimilarity: 0.9,
          searchableText: tool,
        })),
      ),
    );
  });

  afterEach(() => cleanupAllServers());

  describe("the user's own ceiling", () => {
    it('defaults to read: only read-only tools are listed', async () => {
      load();
      expect(await names(alice)).toEqual(READ);
    });

    it('lists more as the user allows more, per user and per server', async () => {
      load();
      await setServerRiskCeiling('alice', 'alpha', 'write');
      expect(await names(alice)).toEqual(WRITE);
      expect(await names(bob)).toEqual(READ);

      await setServerRiskCeiling('alice', 'alpha', 'external');
      expect(await names(alice)).toEqual(ALL);
    });

    it('is stored without selecting, and selecting keeps it', async () => {
      load();
      await setServerRiskCeiling('alice', 'beta', 'external');
      expect(await names(alice)).toEqual(READ);
      await setServerSelected('alice', 'beta', true);
      expect(await names(alice)).toEqual([...READ, 'beta::edit', 'beta::get', 'beta::send']);
      await setServerSelected('alice', 'beta', false);
      await setServerSelected('alice', 'beta', true);
      expect(await names(alice)).toContain('beta::send');
    });

    it('applies on the single-server route', async () => {
      load();
      expect(await names(alice, 'alpha-session')).toEqual(['get']);
      await setServerRiskCeiling('alice', 'alpha', 'write');
      expect(await names(alice, 'alpha-session')).toEqual(['edit', 'get']);
    });

    it('does not apply to admin group routes, userless requests or dashboard calls', async () => {
      load();
      expect(await names(alice, 'team-session')).toEqual([
        ...ALL,
        'beta::edit',
        'beta::get',
        'beta::send',
      ]);
      expect(await names(null)).toContain('alpha::send');
      expect((await call(alice, 'alpha::send', 'team-session')).content[0].text).toBe('alpha ok');
      expect(
        (await call(alice, 'alpha::send', 'aggregate-session', { dashboard: true })).content[0]
          .text,
      ).toBe('alpha ok');
      expect(
        (await call(alice, 'alpha::send', 'aggregate-session', { server: 'alpha' })).content[0]
          .text,
      ).toBe('alpha ok');
    });

    it('refuses a call above it with a status-style result and keeps the audit entry', async () => {
      load();

      const write = await call(alice, 'alpha::edit');
      expect(write.isError).toBe(true);
      expect(metaOf(write)).toEqual({
        server: 'alpha',
        code: 'risk_not_enabled',
        action: 'enable_risk',
        risk: 'write',
      });
      expect(write.content[0].text).toContain("'edit'");
      expect(write.content[0].text).toContain('Allow changes to your data');
      expect(write.content[0].text.startsWith('Error:')).toBe(false);
      expect(callTools.alpha).not.toHaveBeenCalled();

      const external = await call(alice, 'alpha::send');
      expect(metaOf(external).risk).toBe('external');
      expect(external.content[0].text).toContain('Allow actions others can see');

      expect(mockLogToolCall).toHaveBeenCalledWith(
        expect.objectContaining({
          server: 'alpha',
          tool: 'edit',
          status: 'error',
          statusCode: 'risk_not_enabled',
        }),
      );
      expect(
        classifyActivity({ status: 'error', errorMessage: 'x', statusCode: 'risk_not_enabled' }),
      ).toEqual({ result: 'blocked', reason: 'risk_not_enabled' });

      await setServerRiskCeiling('alice', 'alpha', 'write');
      expect((await call(alice, 'alpha::edit')).content[0].text).toBe('alpha ok');
      expect(metaOf(await call(alice, 'alpha::send')).risk).toBe('external');
    });

    it('is checked before the upstream is reached on the single-server route too', async () => {
      load();
      const result = await call(alice, 'edit', 'alpha-session');
      expect(metaOf(result).code).toBe('risk_not_enabled');
      expect(callTools.alpha).not.toHaveBeenCalled();
    });
  });

  describe("the administrator's cap", () => {
    it('limits every non-admin requester on every route, whatever the user allowed', async () => {
      load({ maxToolRisk: 'write' });
      await setServerRiskCeiling('alice', 'alpha', 'external');

      expect(await names(alice)).toEqual(WRITE);
      expect(await names(alice, 'alpha-session')).toEqual(['edit', 'get']);
      expect(await names(alice, 'team-session')).toEqual([
        'alpha::edit',
        'alpha::get',
        'beta::edit',
        'beta::get',
        'beta::send',
      ]);
      expect(await names(null)).not.toContain('alpha::send');
    });

    it('exempts administrators', async () => {
      load({ maxToolRisk: 'read' });
      await setServerRiskCeiling('root', 'alpha', 'external');

      expect(await names(admin, 'team-session')).toContain('alpha::send');
      expect(await names(admin)).toEqual(ALL);
      expect((await call(admin, 'alpha::send', 'team-session')).content[0].text).toBe('alpha ok');
      expect(
        (await call(admin, 'alpha::send', 'aggregate-session', { server: 'alpha' })).content[0]
          .text,
      ).toBe('alpha ok');
    });

    it('still applies the administrator’s own ceiling on the routes selection applies to', async () => {
      load();
      expect(await names(admin)).toEqual(READ);
    });

    it('applies to dashboard calls and group routes for non-admins', async () => {
      load({ maxToolRisk: 'read' });
      const dashboard = await call(alice, 'alpha::send', 'aggregate-session', { server: 'alpha' });
      expect(dashboard.isError).toBe(true);
      expect(metaOf(dashboard)).toBeUndefined();
      expect((await call(alice, 'alpha::send', 'team-session')).isError).toBe(true);
      expect(callTools.alpha).not.toHaveBeenCalled();
    });

    it('refuses with the generic error, byte-identical to a tool that does not exist', async () => {
      load({ maxToolRisk: 'write' });
      await setServerRiskCeiling('alice', 'alpha', 'external');
      const capped = await call(alice, 'alpha::send');

      load({}, false);
      await setServerRiskCeiling('alice', 'alpha', 'external');
      const missing = await call(alice, 'alpha::send');

      expect(capped).toEqual(missing);
      expect(capped.content[0].text).toBe('Error: Tool not available: alpha::send');
      expect(capped._meta).toBeUndefined();
      expect(callTools.alpha).not.toHaveBeenCalled();
    });

    it('also hides a tool above the cap that the user has not allowed (the cap wins)', async () => {
      load({ maxToolRisk: 'read' });
      const result = await call(alice, 'alpha::send');
      expect(result._meta).toBeUndefined();
      expect(result.content[0].text).toBe('Error: Tool not available: alpha::send');
      expect(mockLogToolCall).toHaveBeenCalledWith(
        expect.not.objectContaining({ statusCode: 'risk_not_enabled' }),
      );
    });

    it('keeps an audit entry for a refused call, the same as for a tool that does not exist', async () => {
      useRealActivityLogger = true;
      load({ maxToolRisk: 'read' });
      await call(alice, 'alpha::send');
      await call(alice, 'alpha::send', 'aggregate-session', { server: 'alpha' });
      await metaTool(alice, 'smart-session', 'call_tool', { toolName: 'alpha::send' });
      const capped = mockActivityCreate.mock.calls.map((args) => args[0]);

      mockActivityCreate.mockClear();
      load({}, false);
      await call(alice, 'alpha::send');
      await call(alice, 'alpha::send', 'aggregate-session', { server: 'alpha' });
      await metaTool(alice, 'smart-session', 'call_tool', { toolName: 'alpha::send' });
      const missing = mockActivityCreate.mock.calls.map((args) => args[0]);
      useRealActivityLogger = false;

      expect(capped).toHaveLength(3);
      const comparable = (rows: any[]) => rows.map(({ duration, timestamp, id, ...row }) => row);
      expect(comparable(capped)).toEqual(comparable(missing));
      // The aggregate route records no server and the full requested name, like a missing tool.
      expect(capped[0]).toMatchObject({ server: 'unknown', tool: 'alpha::send', status: 'error' });
      expect(capped[0].statusCode).toBe(missing[0].statusCode);
      expect(classifyActivity(capped[0])).toEqual(classifyActivity(missing[0]));
    });
  });

  describe('overrides', () => {
    it('raise a tool above its computed level, under either key', async () => {
      load({ toolRiskOverrides: { 'alpha::get': 'write', edit: 'external' } });
      expect(await names(alice)).toEqual([]);
      await setServerRiskCeiling('alice', 'alpha', 'write');
      expect(await names(alice)).toEqual(['alpha::get']);
      await setServerRiskCeiling('alice', 'alpha', 'external');
      expect(await names(alice)).toEqual(ALL);
    });

    it('never lower a tool', async () => {
      load({ toolRiskOverrides: { 'alpha::send': 'read', 'alpha::edit': 'read' } });
      expect(await names(alice)).toEqual(READ);
      expect(metaOf(await call(alice, 'alpha::send')).risk).toBe('external');
    });

    it('count toward the cap', async () => {
      load({ maxToolRisk: 'write', toolRiskOverrides: { 'alpha::edit': 'external' } });
      await setServerRiskCeiling('alice', 'alpha', 'external');
      expect(await names(alice)).toEqual(READ);
      expect(await names(admin)).toEqual(READ);
    });
  });

  describe('$smart', () => {
    it('searches only tools within the ceiling and the cap', async () => {
      load();
      expect(await searched(alice)).toEqual(READ);
      await setServerRiskCeiling('alice', 'alpha', 'write');
      expect(await searched(alice)).toEqual(WRITE);

      load({ maxToolRisk: 'read' });
      await setServerRiskCeiling('alice', 'alpha', 'external');
      expect(await searched(alice)).toEqual(READ);
      // The group route is not narrowed by selection, only by the cap.
      expect(await searched(alice, 'smart-team-session')).toEqual([
        'alpha::get',
        'beta::edit',
        'beta::get',
        'beta::send',
      ]);
      expect(await searched(admin, 'smart-team-session')).toHaveLength(6);
    });

    it('does not describe a tool above the ceiling', async () => {
      load();
      const hidden = await metaTool(alice, 'smart-session', 'describe_tool', {
        toolName: 'alpha::send',
      });
      expect(hidden.content[0].text).not.toContain('"name":"alpha::send"');
      const shown = await metaTool(alice, 'smart-session', 'describe_tool', {
        toolName: 'alpha::get',
      });
      expect(shown.content[0].text).toContain('alpha::get');
    });

    it('refuses call_tool above the ceiling with the status shape, and above the cap generically', async () => {
      load();
      const result = await metaTool(alice, 'smart-session', 'call_tool', {
        toolName: 'alpha::edit',
        arguments: {},
      });
      expect(metaOf(result)).toEqual({
        server: 'alpha',
        code: 'risk_not_enabled',
        action: 'enable_risk',
        risk: 'write',
      });
      expect(callTools.alpha).not.toHaveBeenCalled();

      load({ maxToolRisk: 'read' });
      await setServerRiskCeiling('alice', 'alpha', 'external');
      const capped = await metaTool(alice, 'smart-session', 'call_tool', {
        toolName: 'alpha::edit',
        arguments: {},
      });
      expect(capped._meta).toBeUndefined();
      expect(capped.content[0].text).toBe('Error: Tool not available: alpha::edit');
    });

    it('leaves pinned tools above the cap off a group’s $smart list', async () => {
      load({ maxToolRisk: 'read' });
      expect(await names(alice, 'smart-pin-session')).toContain('alpha::get');
      expect(await names(alice, 'smart-pin-session')).not.toContain('alpha::send');
      load();
      expect(await names(alice, 'smart-pin-session')).toContain('alpha::send');
      load({ maxToolRisk: 'read' });
      expect(await names(admin, 'smart-pin-session')).toContain('alpha::send');
    });
  });

  describe('the administrator’s default for users', () => {
    it('is the ceiling of a user who has not chosen one, and a choice wins either way', async () => {
      load({ defaultUserRisk: 'write' });
      expect(await names(alice)).toEqual(WRITE);

      await setServerRiskCeiling('alice', 'alpha', 'read');
      expect(await names(alice)).toEqual(READ);
      await setServerRiskCeiling('alice', 'alpha', 'external');
      expect(await names(alice)).toEqual(ALL);
      expect(await names(bob)).toEqual(WRITE);
    });

    it('applies on the routes selection applies to and refuses above it with the status shape', async () => {
      load({ defaultUserRisk: 'write' });
      expect(await names(alice, 'alpha-session')).toEqual(['edit', 'get']);
      expect(await searched(alice)).toEqual(WRITE);
      expect(metaOf(await call(alice, 'alpha::send')).risk).toBe('external');
      // Not a selection route: untouched.
      expect(await names(alice, 'team-session')).toContain('alpha::send');
    });

    it('can never exceed the cap', async () => {
      load({ maxToolRisk: 'read', defaultUserRisk: 'external' });
      expect(await names(alice)).toEqual(READ);
    });

    it('is ignored with the setting off', async () => {
      workspaceEnabled = false;
      load({ defaultUserRisk: 'write' });
      expect(await names(alice)).toContain('alpha::send');
    });
  });

  describe('annotation trust', () => {
    it('believes annotations only for servers an administrator owns', async () => {
      load({ owner: 'root' });
      await setServerRiskCeiling('alice', 'alpha', 'write');
      expect(await names(alice)).toEqual(WRITE);

      load({ owner: 'mallory' });
      await setServerRiskCeiling('alice', 'alpha', 'write');
      expect(await names(alice)).toEqual([]);
      await setServerRiskCeiling('alice', 'alpha', 'external');
      expect(await names(alice)).toEqual(ALL);
    });

    it('treats every tool of such a server as external for the cap and the refusal', async () => {
      load({ owner: 'mallory', maxToolRisk: 'write' });
      await setServerRiskCeiling('alice', 'alpha', 'external');
      expect(await names(alice)).toEqual([]);
      expect((await call(alice, 'alpha::get')).content[0].text).toBe(
        'Error: Tool not available: alpha::get',
      );
      // Administrators are not capped.
      expect(await names(admin, 'team-session')).toContain('alpha::get');
    });

    it('lets overrides apply on top, which can only keep or raise', async () => {
      load({ owner: 'mallory', toolRiskOverrides: { 'alpha::get': 'read' } });
      await setServerRiskCeiling('alice', 'alpha', 'write');
      expect(await names(alice)).toEqual([]);
    });

    it('lists the real level to nobody but still believes annotations with the setting off', async () => {
      workspaceEnabled = false;
      load({ owner: 'mallory' });
      expect(await names(alice)).toContain('alpha::send');
    });
  });

  describe('a sleeping on-demand server', () => {
    const sleeping = (config: Partial<ServerConfig>) => {
      load({ startOnDemand: true, ...config });
      const info = setServerInfosForTestGet();
      info.status = 'disconnected';
    };
    const setServerInfosForTestGet = () => getServerByName('alpha')!;

    it('is not woken for a tool above the cap, which answers like a missing tool', async () => {
      sleeping({ maxToolRisk: 'read' });
      const result = await metaTool(alice, 'smart-session', 'call_tool', {
        toolName: 'alpha::send',
      });
      expect(result.content[0].text).toBe('Error: Tool not available: alpha::send');
      expect(result._meta).toBeUndefined();
    });

    it('is not woken for a tool above the user’s ceiling either', async () => {
      sleeping({});
      const result = await metaTool(alice, 'smart-session', 'call_tool', {
        toolName: 'alpha::send',
      });
      expect(metaOf(result).code).toBe('risk_not_enabled');
      expect(callTools.alpha).not.toHaveBeenCalled();
    });
  });

  describe('with Workspace Mode off', () => {
    it('changes nothing: no ceiling, no cap, no override', async () => {
      workspaceEnabled = false;
      load({ maxToolRisk: 'read', toolRiskOverrides: { 'alpha::get': 'external' } });

      expect(await names(alice)).toEqual([...ALL, 'beta::edit', 'beta::get', 'beta::send']);
      expect(await names(null, 'alpha-session')).toEqual(['edit', 'get', 'send']);
      expect((await call(alice, 'alpha::send')).content[0].text).toBe('alpha ok');
      expect(await searched(alice)).toHaveLength(6);
    });
  });

  describe('the dashboard projection', () => {
    it('shows each tool’s level to administrators only', async () => {
      const stored = [
        { name: 'alpha', enabled: true, toolRiskOverrides: { 'alpha::get': 'write' } },
        { name: 'beta', enabled: true },
      ];
      (mockServerDao.findAll as jest.Mock<any>).mockResolvedValue(stored);
      load({ toolRiskOverrides: { 'alpha::get': 'write' } });

      const asAdmin = await as(admin, () => getServersInfo());
      const tools = asAdmin.find((server) => server.name === 'alpha')!.tools;
      expect(tools.find((tool) => tool.name === 'alpha::get')!.risk).toEqual({
        computed: 'read',
        override: 'write',
        effective: 'write',
      });
      expect(tools.find((tool) => tool.name === 'alpha::edit')!.risk).toEqual({
        computed: 'write',
        effective: 'write',
      });

      const asUser = await as(alice, () => getServersInfo());
      for (const server of asUser)
        for (const tool of server.tools) expect(tool).not.toHaveProperty('risk');

      workspaceEnabled = false;
      for (const server of await as(admin, () => getServersInfo()))
        for (const tool of server.tools) expect(tool).not.toHaveProperty('risk');
    });

    it('leaves tools above the cap out of the server list for non-admins, owners included', async () => {
      (mockServerDao.findAll as jest.Mock<any>).mockResolvedValue([
        { name: 'alpha', enabled: true, owner: 'alice', maxToolRisk: 'write' },
        { name: 'beta', enabled: true },
      ]);
      load({ owner: 'alice', maxToolRisk: 'write' });
      const toolsOf = async (user: IUser | null) =>
        (await as(user, () => getServersInfo()))
          .find((server) => server.name === 'alpha')!
          .tools.map((tool) => tool.name)
          .sort();

      expect(await toolsOf(alice)).toEqual(WRITE);
      expect(await toolsOf(admin)).toEqual(ALL);
      workspaceEnabled = false;
      expect(await toolsOf(alice)).toEqual(ALL);
    });
  });
});
