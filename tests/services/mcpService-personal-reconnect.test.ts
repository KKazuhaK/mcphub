import { jest } from '@jest/globals';

// A personal runtime is only rebuilt from its own lease's resolved configuration. The reconnect
// path must never reload the shared stored definition for it.

const mockServerDao = { findById: jest.fn<(...args: any[]) => Promise<any>>() };
const created: any[] = [];

class MockSseTransport {
  close = jest.fn();
  constructor(public url: URL) {
    created.push(this);
  }
}
jest.mock('@modelcontextprotocol/client', () => ({
  ...jest.requireActual<object>('@modelcontextprotocol/client'),
  SSEClientTransport: MockSseTransport,
}));

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getCredentialBindingDao: jest.fn(() => ({ delete: jest.fn(async () => undefined) })),
  getUserServerSelectionDao: jest.fn(() => ({})),
}));
jest.mock('../../src/dao/index.js', () => ({
  getGroupDao: jest.fn(() => ({ findAll: jest.fn(async () => []) })),
  getServerDao: jest.fn(() => mockServerDao),
  getSystemConfigDao: jest.fn(() => ({ get: jest.fn(async () => ({})) })),
  getBuiltinPromptDao: jest.fn(() => ({ findEnabled: jest.fn(async () => []) })),
  getBuiltinResourceDao: jest.fn(() => ({ findEnabled: jest.fn(async () => []) })),
}));
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: jest.fn(() => ({})),
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: jest.fn(() => false),
}));
jest.mock('../../src/services/sseService.js', () => ({
  getGroup: jest.fn(),
  getSessionUsername: jest.fn(),
}));
jest.mock('../../src/services/smartRoutingService.js', () => ({
  initSmartRoutingService: jest.fn(),
  getSmartRoutingTools: jest.fn(),
  handleSearchToolsRequest: jest.fn(),
  handleDescribeToolRequest: jest.fn(),
  isSmartRoutingGroup: jest.fn(() => false),
}));
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: jest.fn(() => ({ logToolCall: jest.fn(async () => undefined) })),
}));
jest.mock('../../src/services/hostedAuthService.js', () => ({
  assertHostedToolAllowed: jest.fn(),
  filterHostedTools: jest.fn((_a: unknown, _b: unknown, tools: unknown) => tools),
  reserveHostedToolCall: jest.fn(async () => null),
  settleHostedToolCall: jest.fn(async () => undefined),
}));
jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn(),
}));
jest.mock('../../src/services/oauthService.js', () => ({ initializeAllOAuthClients: jest.fn() }));
jest.mock('../../src/services/mcpOAuthProvider.js', () => ({ createOAuthProvider: jest.fn() }));
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

import { callToolWithReconnect } from '../../src/services/mcpService.js';

const failure = Object.assign(new Error('boom'), { status: 404 });
const slot = [{ target: 'headers', name: 'Authorization' }];
const serverInfo = (config: Record<string, unknown>) => {
  const client = {
    callTool: jest.fn<(...args: any[]) => Promise<any>>().mockRejectedValue(failure),
  };
  const transport = new MockSseTransport(new URL('https://a.example.com/sse'));
  created.length = 0;
  created.push(transport);
  return {
    info: {
      name: 'shared',
      status: 'connected',
      tools: [],
      prompts: [],
      resources: [],
      error: null,
      createTime: Date.now(),
      client,
      transport,
      config,
    } as any,
    client,
    transport,
  };
};

beforeEach(() => {
  jest.clearAllMocks();
  mockServerDao.findById.mockResolvedValue({
    name: 'shared',
    type: 'sse',
    url: 'https://a.example.com/sse',
    credentialTemplate: slot,
  });
});

test('a personal runtime is never reconnected, and the stored definition is never read', async () => {
  const { info, client, transport } = serverInfo({
    type: 'sse',
    url: 'https://a.example.com/sse',
    credentialTemplate: slot,
  });
  await expect(callToolWithReconnect(info, { name: 'x', arguments: {} })).rejects.toBe(failure);
  expect(client.callTool).toHaveBeenCalledTimes(1);
  expect(mockServerDao.findById).not.toHaveBeenCalled();
  expect(created).toEqual([transport]);
  expect(info.client).toBe(client);
});

test('a runtime whose own config lacks the template is still not rebuilt from a personal stored definition', async () => {
  const { info, client, transport } = serverInfo({ type: 'sse', url: 'https://a.example.com/sse' });
  await expect(callToolWithReconnect(info, { name: 'x', arguments: {} })).rejects.toBe(failure);
  // No connection was built from the shared definition, and the runtime kept its own.
  expect(created).toEqual([transport]);
  expect(info.client).toBe(client);
  expect(info.transport).toBe(transport);
});
