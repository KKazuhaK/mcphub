let workspaceEnabled = true;
let currentUser: { username: string; isAdmin: boolean } | null = null;

const connected = (name: string) => ({
  name,
  status: 'connected',
  enabled: true,
  tools: [{ name: `${name}::ping`, description: 'Ping', inputSchema: { type: 'object' } }],
  prompts: [],
  resources: [],
});

jest.mock('../../src/services/mcpService.js', () => ({
  getServersInfo: jest.fn(async () => [connected('alpha'), connected('beta'), connected('gamma')]),
}));
jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: jest.fn(() => ({ get: jest.fn(async () => ({})) })),
  getServerDao: jest.fn(() => ({
    findAll: jest.fn(async () => [
      { name: 'alpha', maintenance: {} },
      { name: 'beta', pausedUsers: ['alice'] },
      { name: 'gamma' },
    ]),
  })),
}));
jest.mock('../../src/services/userContextService.js', () => ({
  UserContextService: { getInstance: () => ({ getCurrentUser: () => currentUser }) },
}));
jest.mock('../../src/services/userServerSelectionService.js', () => ({
  isWorkspaceEnabled: () => workspaceEnabled,
}));

import { generateOpenAPISpec } from '../../src/services/openApiGeneratorService.js';

const paths = async () => Object.keys((await generateOpenAPISpec()).paths).sort();

describe('OpenAPI specification under Workspace Mode', () => {
  beforeEach(() => {
    workspaceEnabled = true;
  });

  it('leaves out servers in maintenance or paused for the requester', async () => {
    currentUser = { username: 'alice', isAdmin: false };
    expect(await paths()).toEqual([expect.stringContaining('gamma')]);

    currentUser = { username: 'bob', isAdmin: false };
    expect(await paths()).toEqual([
      expect.stringContaining('beta'),
      expect.stringContaining('gamma'),
    ]);
  });

  it('lets administrators see servers in maintenance, and treats a missing user as non-admin', async () => {
    currentUser = { username: 'root', isAdmin: true };
    expect(await paths()).toHaveLength(3);

    currentUser = null;
    expect(await paths()).toEqual([
      expect.stringContaining('beta'),
      expect.stringContaining('gamma'),
    ]);
  });

  it('ignores both fields with the setting off', async () => {
    workspaceEnabled = false;
    currentUser = { username: 'alice', isAdmin: false };
    expect(await paths()).toHaveLength(3);
  });
});
