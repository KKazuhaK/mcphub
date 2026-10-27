import express from 'express';
import request from 'supertest';

let stored: Record<string, any>;
const signingKeyRows = [{ kid: 'k1', privateKey: 'enc:v1.SECRET-PRIVATE-MATERIAL' }];

const systemConfigDao = {
  get: async () => stored,
  update: async (next: Record<string, any>) => {
    stored = next;
    return next;
  },
};
const emptyDao = { findAll: async () => [], getAll: async () => [], findEnabled: async () => [] };

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => ({
    findByUsername: async (username: string) => ({
      username,
      password: 'unused',
      isAdmin: username === 'admin',
    }),
    findAll: async () => [],
  }),
  getSystemConfigDao: () => systemConfigDao,
  getBearerKeyDao: () => emptyDao,
  getOAuthTokenDao: () => emptyDao,
  getOAuthClientDao: () => emptyDao,
  getServerDao: () => emptyDao,
  getGroupDao: () => emptyDao,
  getUserConfigDao: () => emptyDao,
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getSystemConfigDao: () => systemConfigDao,
  getBearerKeyDao: () => emptyDao,
  getOAuthTokenDao: () => emptyDao,
  getOAuthClientDao: () => emptyDao,
  getServerDao: () => emptyDao,
  getGroupDao: () => emptyDao,
  getUserConfigDao: () => emptyDao,
  getUserDao: () => emptyDao,
}));
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: jest.fn(() => null),
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: () => false,
}));
jest.mock('../../src/services/oauthServerService.js', () => ({
  isOAuthServerEnabled: jest.fn(() => false),
}));
jest.mock('../../src/services/betterAuthConfig.js', () => ({
  getBetterAuthRuntimeConfig: jest.fn().mockResolvedValue({ enabled: false }),
}));
jest.mock('../../src/services/mcpService.js', () => ({
  getServersInfo: jest.fn(),
  getServerByName: jest.fn(),
  notifyToolChanged: jest.fn(),
}));
jest.mock('../../src/services/vectorSearchService.js', () => ({}));
jest.mock('../../src/services/upstreamOAuthDisconnectService.js', () => ({}));
jest.mock('../../src/services/logService.js', () => ({
  default: { getLogs: jest.fn(), clearLogs: jest.fn(), subscribeToStream: jest.fn() },
}));
jest.mock('../../src/db/connection.js', () => ({
  getAppDataSource: () => ({
    getRepository: () => ({ find: async () => signingKeyRows }),
  }),
}));

import { auth } from '../../src/middlewares/auth.js';
import { authenticatedRouteRateLimiter } from '../../src/utils/rateLimit.js';
import { updateSystemConfig } from '../../src/controllers/serverController.js';
import { getMcpSettingsJson } from '../../src/controllers/configController.js';
import { createAdminToken, createUserToken } from '../utils/testHelpers.js';

const resources = [
  { resource: 'https://ubc.example/mcp', name: 'UBC', allowedClients: ['ubc-pub'] },
  { resource: 'http://localhost:9000/mcp', name: 'Local' },
];

describe('oauthServer.externalResources configuration', () => {
  let app: express.Application;

  beforeEach(() => {
    stored = {
      routing: { enableBearerAuth: false, skipAuth: false },
      oauthServer: { enabled: true },
    };
    app = express();
    app.use(express.json());
    app.put('/api/system-config', authenticatedRouteRateLimiter, auth, updateSystemConfig);
    app.get('/api/mcp-settings/export', authenticatedRouteRateLimiter, auth, getMcpSettingsJson);
  });

  const put = (token: string, body: unknown) =>
    request(app)
      .put('/api/system-config')
      .set('x-auth-token', token)
      .send(body as object);

  it('is refused for a non-admin, and nothing is stored', async () => {
    const response = await put(createUserToken('alice', false), {
      oauthServer: { externalResources: resources },
    });
    expect(response.status).toBe(403);
    expect(stored.oauthServer.externalResources).toBeUndefined();
  });

  it('is stored for an administrator', async () => {
    const response = await put(createAdminToken(), {
      oauthServer: { externalResources: resources },
    });
    expect(response.status).toBe(200);
    expect(stored.oauthServer.externalResources).toEqual(resources);
    expect(stored.oauthServer.enabled).toBe(true);
  });

  it('can be cleared with null or an empty list', async () => {
    stored.oauthServer.externalResources = resources;
    expect(
      (await put(createAdminToken(), { oauthServer: { externalResources: null } })).status,
    ).toBe(200);
    expect(stored.oauthServer.externalResources).toEqual([]);
  });

  it.each([
    ['not an array', 'https://ubc.example/mcp'],
    ['plain http on a public host', [{ resource: 'http://ubc.example/mcp', name: 'x' }]],
    ['a relative URL', [{ resource: '/mcp', name: 'x' }]],
    ['a fragment', [{ resource: 'https://ubc.example/mcp#a', name: 'x' }]],
    ['credentials in the URL', [{ resource: 'https://u:p@ubc.example/mcp', name: 'x' }]],
    ['a missing name', [{ resource: 'https://ubc.example/mcp' }]],
    [
      'a duplicate',
      [
        { resource: 'https://ubc.example/mcp', name: 'a' },
        { resource: 'https://ubc.example/mcp', name: 'b' },
      ],
    ],
    [
      'bad allowedClients',
      [{ resource: 'https://ubc.example/mcp', name: 'a', allowedClients: [1] }],
    ],
  ])('rejects %s with 400 and stores nothing', async (_label, value) => {
    const response = await put(createAdminToken(), { oauthServer: { externalResources: value } });
    expect(response.status).toBe(400);
    expect(stored.oauthServer.externalResources).toBeUndefined();
  });

  it('keeps signing key material out of the settings export', async () => {
    stored.oauthServer.externalResources = resources;
    const response = await request(app)
      .get('/api/mcp-settings/export')
      .set('x-auth-token', createAdminToken());
    expect(response.status).toBe(200);
    const text = JSON.stringify(response.body);
    expect(text).toContain('https://ubc.example/mcp');
    expect(text).not.toContain('SECRET-PRIVATE-MATERIAL');
    expect(text).not.toMatch(/privateKey|signing/i);
  });
});
