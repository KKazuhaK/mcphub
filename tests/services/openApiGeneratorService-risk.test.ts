let workspaceEnabled = true;
let currentUser: { username: string; isAdmin: boolean } | null = null;
let stored: Record<string, unknown> = {};

const tool = (name: string, annotations?: Record<string, unknown>) => ({
  name,
  description: name,
  inputSchema: { type: 'object' },
  ...(annotations ? { annotations } : {}),
});

jest.mock('../../src/config/index.js', () => ({
  getNameSeparator: () => '::',
  default: { port: 3000, basePath: '' },
}));
jest.mock('../../src/services/mcpService.js', () => ({
  getServersInfo: jest.fn(async () => [
    {
      name: 'svc',
      status: 'connected',
      enabled: true,
      tools: [
        tool('svc::get', { readOnlyHint: true }),
        tool('svc::edit', { openWorldHint: false }),
        tool('svc::send'),
      ],
      prompts: [],
      resources: [],
    },
  ]),
}));
jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: jest.fn(() => ({ get: jest.fn(async () => ({})) })),
  getServerDao: jest.fn(() => ({ findAll: jest.fn(async () => [{ name: 'svc', ...stored }]) })),
}));
jest.mock('../../src/services/userContextService.js', () => ({
  UserContextService: { getInstance: () => ({ getCurrentUser: () => currentUser }) },
}));
jest.mock('../../src/services/userServerSelectionService.js', () => ({
  isWorkspaceEnabled: () => workspaceEnabled,
}));

import { generateOpenAPISpec } from '../../src/services/openApiGeneratorService.js';

const tools = async () =>
  Object.keys((await generateOpenAPISpec()).paths)
    .map((path) => decodeURIComponent(path.split('/').pop() as string))
    .sort();

describe('OpenAPI specification and the administrator’s tool risk cap', () => {
  beforeEach(() => {
    workspaceEnabled = true;
    stored = {};
    currentUser = { username: 'alice', isAdmin: false };
  });

  it('lists every tool without a cap', async () => {
    expect(await tools()).toEqual(['edit', 'get', 'send']);
  });

  it('leaves out tools above the cap for non-admins, and for a request without a user', async () => {
    stored = { maxToolRisk: 'write' };
    expect(await tools()).toEqual(['edit', 'get']);
    stored = { maxToolRisk: 'read' };
    expect(await tools()).toEqual(['get']);
    currentUser = null;
    expect(await tools()).toEqual(['get']);
  });

  it('counts an override raising a tool, but never one lowering it', async () => {
    stored = { maxToolRisk: 'read', toolRiskOverrides: { get: 'write', send: 'read' } };
    expect(await tools()).toEqual([]);
  });

  it('does not limit administrators', async () => {
    stored = { maxToolRisk: 'read' };
    currentUser = { username: 'root', isAdmin: true };
    expect(await tools()).toEqual(['edit', 'get', 'send']);
  });

  it('ignores the cap with the setting off', async () => {
    stored = { maxToolRisk: 'read' };
    workspaceEnabled = false;
    expect(await tools()).toEqual(['edit', 'get', 'send']);
  });
});
