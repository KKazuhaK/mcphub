import express from 'express';
import request from 'supertest';
import type { ServerConfig } from '../../src/types/index.js';

type ServerRecord = ServerConfig & { name: string };

let servers: ServerRecord[];
let groupNames: string[];
let workspaceConfig: Record<string, unknown> | null;
const selectionRows: Array<{
  username: string;
  serverName: string;
  selected: boolean;
  updatedAt: string;
}> = [];
const mockNotifyUserListsChanged = jest.fn();
const mockGetCredentialBindingStatus = jest.fn();

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getGroupDao: () => ({
    findByName: async (name: string) => (groupNames.includes(name) ? { name } : null),
    findById: async () => null,
  }),
  getServerDao: () => ({
    findAll: async () => servers,
    findById: async (name: string) => servers.find((server) => server.name === name) ?? null,
  }),
  getUserServerSelectionDao: () => ({
    listByUsername: async (username: string) =>
      selectionRows.filter((row) => row.username === username),
    save: async (selection: (typeof selectionRows)[number]) => {
      const index = selectionRows.findIndex(
        (row) => row.username === selection.username && row.serverName === selection.serverName,
      );
      if (index >= 0) selectionRows.splice(index, 1);
      selectionRows.push(selection);
    },
  }),
}));
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: () => workspaceConfig,
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: () => false,
}));
jest.mock('../../src/config/index.js', () => ({
  getNameSeparator: () => '::',
  default: { basePath: '' },
}));
jest.mock('../../src/services/mcpService.js', () => ({
  getServerByName: (name: string) => ({
    name,
    tools: [{ name: `${name}::a` }, { name: `${name}::b` }, { name: 'bare' }],
  }),
  notifyUserListsChanged: (...args: unknown[]) => mockNotifyUserListsChanged(...args),
}));
jest.mock('../../src/services/credentialBindingService.js', () => ({
  getCredentialBindingStatus: (...args: unknown[]) => mockGetCredentialBindingStatus(...args),
}));
jest.mock('../../src/services/personalOAuthService.js', () => ({
  hasPersonalOAuth: () => false,
  PersonalOAuthContext: {},
}));

import {
  getWorkspaceEndpoints,
  listWorkspaceServers,
  updateWorkspaceSelection,
} from '../../src/controllers/workspaceController.js';
import { clearServerSelectionCache } from '../../src/services/userServerSelectionService.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  // Stand-in for dashboard authentication.
  app.use((req, _res, next) => {
    const header = req.headers['x-test-user'];
    if (typeof header === 'string') (req as any).user = JSON.parse(header);
    next();
  });
  app.get('/api/workspace/servers', listWorkspaceServers);
  app.put('/api/workspace/servers/:name/selection', updateWorkspaceSelection);
  app.get('/api/workspace/endpoints', getWorkspaceEndpoints);
  return app;
};

const asUser = (username: string, isAdmin = false) => JSON.stringify({ username, isAdmin });

describe('workspace API', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    selectionRows.length = 0;
    groupNames = [];
    clearServerSelectionCache();
    workspaceConfig = { workspace: { enabled: true } };
    mockGetCredentialBindingStatus.mockResolvedValue({ configured: false });
    servers = [
      { name: 'public-tool', owner: 'admin', visibility: 'public', description: 'Shared' },
      { name: 'private-tool', owner: 'admin', visibility: 'private' },
      { name: 'alice-tool', owner: 'alice', visibility: 'private', enabled: false },
      {
        name: 'needs-key',
        owner: 'admin',
        visibility: 'public',
        credentialTemplate: [{ target: 'env', name: 'API_KEY' }],
      },
    ];
  });

  describe('when the workspace setting is off', () => {
    it.each([{}, { workspace: { enabled: false } }, null])(
      'answers 404 on every route for %j',
      async (config) => {
        workspaceConfig = config;
        const headers = { 'x-test-user': asUser('alice') };

        await request(app).get('/api/workspace/servers').set(headers).expect(404);
        await request(app)
          .put('/api/workspace/servers/public-tool/selection')
          .set(headers)
          .send({ selected: true })
          .expect(404);
        await request(app).get('/api/workspace/endpoints').set(headers).expect(404);
        expect(selectionRows).toEqual([]);
      },
    );
  });

  it('requires an authenticated user', async () => {
    await request(app).get('/api/workspace/servers').expect(401);
  });

  describe('GET /workspace/servers', () => {
    it('lists the servers visible to the user with their selection state', async () => {
      selectionRows.push({
        username: 'alice',
        serverName: 'public-tool',
        selected: true,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });

      const response = await request(app)
        .get('/api/workspace/servers')
        .set('x-test-user', asUser('alice'))
        .expect(200);

      expect(response.body.data).toEqual([
        {
          name: 'public-tool',
          description: 'Shared',
          selected: true,
          enabled: true,
          toolCount: 3,
          requiresPersonalCredential: false,
          credentialConfigured: true,
        },
        {
          name: 'alice-tool',
          selected: false,
          enabled: false,
          toolCount: 3,
          requiresPersonalCredential: false,
          credentialConfigured: true,
        },
        {
          name: 'needs-key',
          selected: false,
          enabled: true,
          toolCount: 3,
          requiresPersonalCredential: true,
          credentialConfigured: false,
        },
      ]);
      expect(mockGetCredentialBindingStatus).toHaveBeenCalledWith(
        'needs-key',
        'alice',
        expect.objectContaining({ name: 'needs-key' }),
      );
    });

    it('reports a configured personal credential', async () => {
      mockGetCredentialBindingStatus.mockResolvedValue({ configured: true });

      const response = await request(app)
        .get('/api/workspace/servers')
        .set('x-test-user', asUser('bob'))
        .expect(200);

      expect(
        response.body.data.find((server: { name: string }) => server.name === 'needs-key'),
      ).toMatchObject({ requiresPersonalCredential: true, credentialConfigured: true });
    });

    it('shows an admin every server, as the dashboard does', async () => {
      const response = await request(app)
        .get('/api/workspace/servers')
        .set('x-test-user', asUser('root', true))
        .expect(200);

      expect(response.body.data).toHaveLength(4);
    });
  });

  describe('PUT /workspace/servers/:name/selection', () => {
    const select = (name: string, body: unknown, user = 'alice') =>
      request(app)
        .put(`/api/workspace/servers/${name}/selection`)
        .set('x-test-user', asUser(user))
        .send(body as object);

    it('stores the selection for the session user and notifies only that user', async () => {
      await select('public-tool', { selected: true }).expect(200);

      expect(selectionRows).toEqual([
        expect.objectContaining({ username: 'alice', serverName: 'public-tool', selected: true }),
      ]);
      expect(mockNotifyUserListsChanged).toHaveBeenCalledTimes(1);
      expect(mockNotifyUserListsChanged).toHaveBeenCalledWith('alice');

      await select('public-tool', { selected: false }).expect(200);
      expect(selectionRows).toEqual([
        expect.objectContaining({ username: 'alice', serverName: 'public-tool', selected: false }),
      ]);
    });

    it('takes the username from the session, never from the request', async () => {
      await select('public-tool', { selected: true, username: 'mallory' }).expect(200);
      await request(app)
        .put('/api/workspace/servers/public-tool/selection?username=mallory')
        .set('x-test-user', asUser('alice'))
        .send({ selected: true })
        .expect(200);

      expect(selectionRows.map((row) => row.username)).toEqual(['alice']);
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalledWith('mallory');
    });

    it('answers 404 for a server the user cannot see, and for one that does not exist', async () => {
      await select('private-tool', { selected: true }).expect(404);
      await select('missing', { selected: true }).expect(404);

      expect(selectionRows).toEqual([]);
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
    });

    it.each([{}, { selected: 'yes' }, { selected: 1 }, { selected: null }])(
      'answers 400 for the body %j',
      async (body) => {
        await select('public-tool', body).expect(400);
        expect(selectionRows).toEqual([]);
      },
    );
  });

  describe('GET /workspace/endpoints', () => {
    it('builds the aggregate and single-server URLs of the selected, enabled servers', async () => {
      workspaceConfig = {
        workspace: { enabled: true },
        install: { baseUrl: 'https://hub.example.com/mcphub/' },
      };
      const now = '2026-01-01T00:00:00.000Z';
      selectionRows.push(
        { username: 'alice', serverName: 'public-tool', selected: true, updatedAt: now },
        // Selected, but globally disabled.
        { username: 'alice', serverName: 'alice-tool', selected: true, updatedAt: now },
        // Explicitly deselected.
        { username: 'alice', serverName: 'needs-key', selected: false, updatedAt: now },
        // Another user's choice.
        { username: 'bob', serverName: 'needs-key', selected: true, updatedAt: now },
      );

      const response = await request(app)
        .get('/api/workspace/endpoints')
        .set('x-test-user', asUser('alice'))
        .expect(200);

      expect(response.body.data).toEqual({
        aggregate: 'https://hub.example.com/mcphub/alice/mcp',
        servers: [
          { name: 'public-tool', url: 'https://hub.example.com/mcphub/alice/mcp/public-tool' },
        ],
      });
    });

    it('gives no per-server URL to a server whose name is also a group', async () => {
      groupNames = ['public-tool'];
      const now = '2026-01-01T00:00:00.000Z';
      selectionRows.push(
        { username: 'alice', serverName: 'public-tool', selected: true, updatedAt: now },
        { username: 'alice', serverName: 'needs-key', selected: true, updatedAt: now },
      );

      const response = await request(app)
        .get('/api/workspace/endpoints')
        .set('x-test-user', asUser('alice'))
        .set('Host', 'localhost:3000')
        .expect(200);

      expect(response.body.data.servers).toEqual([
        { name: 'public-tool', url: null, conflict: 'group-name' },
        { name: 'needs-key', url: 'http://localhost:3000/alice/mcp/needs-key' },
      ]);
    });

    it('falls back to the request host when no base URL is configured', async () => {
      const response = await request(app)
        .get('/api/workspace/endpoints')
        .set('x-test-user', asUser('alice'))
        .set('Host', 'localhost:3000')
        .expect(200);

      expect(response.body.data).toEqual({
        aggregate: 'http://localhost:3000/alice/mcp',
        servers: [],
      });
    });
  });
});
