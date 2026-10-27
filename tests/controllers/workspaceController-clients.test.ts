import express from 'express';
import request from 'supertest';
import type { BearerKey, IOAuthClient, IOAuthToken } from '../../src/types/index.js';

let tokens: IOAuthToken[];
let keys: BearerKey[];
let clients: IOAuthClient[];
let workspaceConfig: Record<string, unknown> | null;
const closeSessions = jest.fn();

jest.mock('../../src/dao/index.js', () => ({
  getOAuthTokenDao: () => ({
    findByUsername: async (username: string) => tokens.filter((t) => t.username === username),
    revokeUserClientTokens: async (username: string, clientId: string) => {
      tokens = tokens.filter((t) => !(t.username === username && t.clientId === clientId));
      return 1;
    },
    revokeUserTokens: async (username: string) => {
      tokens = tokens.filter((t) => t.username !== username);
      return 1;
    },
  }),
  getOAuthClientDao: () => ({
    findByClientId: async (clientId: string) =>
      clients.find((c) => c.clientId === clientId) ?? null,
  }),
  getBearerKeyDao: () => ({
    findByOwner: async (owner: string) =>
      keys.filter((k) => k.kind === 'user' && k.owner === owner),
    findById: async (id: string) => keys.find((k) => k.id === id),
    delete: async (id: string) => {
      keys = keys.filter((k) => k.id !== id);
      return true;
    },
    deleteByOwner: async (owner: string) => {
      keys = keys.filter((k) => !(k.kind === 'user' && k.owner === owner));
      return 1;
    },
  }),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getGroupDao: () => ({}),
  getServerDao: () => ({}),
  getUserServerSelectionDao: () => ({}),
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
jest.mock('../../src/services/sseService.js', () => ({
  closeSessionsForCredential: (...args: unknown[]) => closeSessions(...args),
}));
jest.mock('../../src/services/mcpService.js', () => ({}));
jest.mock('../../src/services/credentialBindingService.js', () => ({}));
jest.mock('../../src/services/personalOAuthService.js', () => ({}));

import {
  listWorkspaceClients,
  revokeAllWorkspaceClients,
  revokeWorkspaceClient,
} from '../../src/controllers/workspaceController.js';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const header = req.headers['x-test-user'];
  if (typeof header === 'string') (req as any).user = JSON.parse(header);
  next();
});
app.get('/api/workspace/clients', listWorkspaceClients);
app.delete('/api/workspace/clients/:kind/:id', revokeWorkspaceClient);
app.delete('/api/workspace/clients', revokeAllWorkspaceClients);

const as = (username: string) => JSON.stringify({ username, isAdmin: false });
const token = (overrides: Partial<IOAuthToken>): IOAuthToken => ({
  accessToken: 'secret-access',
  accessTokenExpiresAt: new Date(Date.now() + 3600_000),
  refreshToken: 'secret-refresh',
  refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
  clientId: 'client-a',
  username: 'alice',
  ...overrides,
});
const key = (overrides: Partial<BearerKey>): BearerKey => ({
  id: 'key-1',
  name: 'laptop',
  token: 'secret-key-value',
  enabled: true,
  kind: 'user',
  owner: 'alice',
  accessType: 'all',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  workspaceConfig = { workspace: { enabled: true } };
  closeSessions.mockClear();
  clients = [{ clientId: 'client-a', name: 'Claude', redirectUris: [], grants: [] }];
  tokens = [
    token({ accessToken: 'a-alice', refreshToken: 'ra' }),
    token({ accessToken: 'b-alice', refreshToken: 'rb', clientId: 'client-b' }),
    token({ accessToken: 'a-bob', refreshToken: 'rc', username: 'bob' }),
    token({ accessToken: 'c-bob', refreshToken: 'rd', username: 'bob', clientId: 'bobs-client' }),
  ];
  keys = [key({}), key({ id: 'key-2', name: 'phone' }), key({ id: 'bob-key', owner: 'bob' })];
});

describe('connected clients API', () => {
  describe('workspace off', () => {
    it.each([{}, { workspace: { enabled: false } }, null])('answers 404 for %j', async (cfg) => {
      workspaceConfig = cfg;
      const before = { tokens: [...tokens], keys: [...keys] };
      for (const res of [
        await request(app).get('/api/workspace/clients').set('x-test-user', as('alice')),
        await request(app).delete('/api/workspace/clients').set('x-test-user', as('alice')),
        await request(app)
          .delete('/api/workspace/clients/oauth/client-a')
          .set('x-test-user', as('alice')),
        await request(app)
          .delete('/api/workspace/clients/key/key-1')
          .set('x-test-user', as('alice')),
      ]) {
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ success: false, message: 'Not found' });
      }
      expect(tokens).toEqual(before.tokens);
      expect(keys).toEqual(before.keys);
    });
  });

  it('requires an authenticated user', async () => {
    expect((await request(app).get('/api/workspace/clients')).status).toBe(401);
    expect((await request(app).delete('/api/workspace/clients')).status).toBe(401);
  });

  it('lists only the caller’s clients and never a token or key value', async () => {
    const res = await request(app).get('/api/workspace/clients').set('x-test-user', as('alice'));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const ids = res.body.data.map((c: any) => `${c.kind}:${c.id}`).sort();
    expect(ids).toEqual(['key:key-1', 'key:key-2', 'oauth:client-a', 'oauth:client-b']);
    expect(res.body.data.find((c: any) => c.id === 'client-a').name).toBe('Claude');
    expect(res.body.data.find((c: any) => c.id === 'key-1')).toEqual({
      id: 'key-1',
      kind: 'key',
      name: 'laptop',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
      enabled: true,
      idle: false,
    });
    const text = JSON.stringify(res.body);
    for (const leaked of ['secret', 'a-alice', 'ra', '"rb"', 'bob', 'bobs-client']) {
      expect(text).not.toContain(leaked);
    }
  });

  it('lists idle clients flagged, so they can still be revoked', async () => {
    workspaceConfig = {
      workspace: { enabled: true, clientIdleDays: 30, enabledAt: '2020-01-01T00:00:00.000Z' },
    };
    keys = [
      key({ lastUsedAt: '2021-01-01T00:00:00.000Z' }),
      key({ id: 'key-2', lastUsedAt: new Date().toISOString() }),
    ];
    const res = await request(app).get('/api/workspace/clients').set('x-test-user', as('alice'));
    const byId = Object.fromEntries(res.body.data.map((c: any) => [c.id, c.idle]));
    expect(byId['key-1']).toBe(true);
    expect(byId['key-2']).toBe(false);
    expect(
      (
        await request(app)
          .delete('/api/workspace/clients/key/key-1')
          .set('x-test-user', as('alice'))
      ).status,
    ).toBe(200);
  });

  it('revokes one OAuth client without touching the caller’s others or other users', async () => {
    const res = await request(app)
      .delete('/api/workspace/clients/oauth/client-a')
      .set('x-test-user', as('alice'));
    expect(res.status).toBe(200);
    expect(tokens.map((t) => t.accessToken).sort()).toEqual(['a-bob', 'b-alice', 'c-bob']);
    expect(keys).toHaveLength(3);
    expect(closeSessions).toHaveBeenCalledWith('alice', { kind: 'oauth', id: 'client-a' });
  });

  it('revokes one key', async () => {
    const res = await request(app)
      .delete('/api/workspace/clients/key/key-1')
      .set('x-test-user', as('alice'));
    expect(res.status).toBe(200);
    expect(keys.map((k) => k.id)).toEqual(['key-2', 'bob-key']);
    expect(tokens).toHaveLength(4);
  });

  it('answers a foreign id and a missing id identically', async () => {
    const attempts = [
      ['oauth', 'bobs-client'],
      ['oauth', 'no-such-client'],
      ['key', 'bob-key'],
      ['key', 'no-such-key'],
      ['bogus', 'client-a'],
    ];
    const responses = [];
    for (const [kind, id] of attempts) {
      responses.push(
        await request(app)
          .delete(`/api/workspace/clients/${kind}/${id}`)
          .set('x-test-user', as('alice')),
      );
    }
    for (const res of responses) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(responses[0].body);
    }
    expect(tokens).toHaveLength(4);
    expect(keys).toHaveLength(3);
  });

  it('revokes all of the caller’s clients and nobody else’s', async () => {
    const res = await request(app).delete('/api/workspace/clients').set('x-test-user', as('alice'));
    expect(res.status).toBe(200);
    expect(tokens.every((t) => t.username === 'bob')).toBe(true);
    expect(keys.map((k) => k.id)).toEqual(['bob-key']);
    expect(closeSessions).toHaveBeenCalledWith('alice', undefined);

    const after = await request(app).get('/api/workspace/clients').set('x-test-user', as('alice'));
    expect(after.body.data).toEqual([]);
  });
});
