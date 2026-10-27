jest.mock('openid-client', () => ({}));
jest.mock('../../src/db/connection.js', () => ({ getDatabase: jest.fn() }));
jest.mock('../../src/services/vectorSearchService.js', () => ({ VectorSearchService: jest.fn() }));
jest.mock('../../src/utils/oauthBearer.js', () => ({ resolveOAuthGrantFromToken: jest.fn() }));
jest.mock('../../src/dao/index.js', () => ({
  getBearerKeyDao: jest.fn(),
  getGroupDao: jest.fn(),
  getSystemConfigDao: jest.fn(),
  getUserDao: jest.fn(),
  getOAuthTokenDao: jest.fn(),
}));
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: () => (globalThis as any).__systemConfig,
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: () => false,
}));
jest.mock('../../src/config/index.js', () => ({
  __esModule: true,
  default: { basePath: '' },
  loadSettings: jest.fn(),
}));
jest.mock('../../src/services/mcpService.js');
const mockUserContext = {
  getCurrentUser: jest.fn().mockReturnValue({ username: 'alice' }),
  setCurrentUser: jest.fn(),
  clearCurrentUser: jest.fn(),
  hasUser: jest.fn().mockReturnValue(false),
};
jest.mock('../../src/services/userContextService.js', () => ({
  UserContextService: { getInstance: jest.fn(() => mockUserContext) },
}));
jest.mock('../../src/services/requestContextService.js', () => ({
  RequestContextService: { getInstance: jest.fn(() => ({})) },
}));
const mockTransport = { sessionId: 'sess-1', send: jest.fn(), close: jest.fn(), onclose: null };
jest.mock('@modelcontextprotocol/server-legacy/sse', () => ({
  SSEServerTransport: jest.fn().mockImplementation(() => mockTransport),
}));

import { describeBearerToken } from '../../src/utils/bearerKeyHash.js';
import type { Request, Response } from 'express';
import {
  closeSessionsForCredential,
  handleSseConnection,
  transports,
} from '../../src/services/sseService.js';
import { resetLastUsedThrottle } from '../../src/services/connectedClientService.js';
import { resolveOAuthGrantFromToken } from '../../src/utils/oauthBearer.js';
import * as mcpService from '../../src/services/mcpService.js';
import * as daoIndex from '../../src/dao/index.js';
import type { BearerKey } from '../../src/types/index.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T00:00:00.000Z').getTime();

let keys: BearerKey[];
let systemConfig: Record<string, unknown>;
// The idle setting is read from the cached system config for keys and OAuth alike.
const setConfig = (config: Record<string, unknown>) => {
  systemConfig = config;
  (globalThis as any).__systemConfig = config;
};
const LONG_AGO = new Date(NOW - 1000 * DAY).toISOString();
const workspaceOn = (extra: Record<string, unknown> = {}) => ({
  enabled: true,
  enabledAt: new Date(NOW - DAY).toISOString(),
  ...extra,
});
const keyUpdate = jest.fn();
const tokenUpdate = jest.fn();

const userKey = (overrides: Partial<BearerKey> = {}): BearerKey => ({
  id: 'key-1',
  name: 'laptop',
  ...describeBearerToken('user-key-secret'),
  enabled: true,
  kind: 'user',
  owner: 'alice',
  accessType: 'all',
  createdAt: new Date(NOW - 500 * DAY).toISOString(),
  ...overrides,
});

const connect = async (token: string, params: Record<string, string> = { group: 'g' }) => {
  const res = {
    on: jest.fn(),
    setHeader: jest.fn(),
    writeHead: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  const req = {
    params,
    query: {},
    headers: { authorization: `Bearer ${token}`, host: 'hub.example' },
    protocol: 'https',
    originalUrl: '/mcp/g',
    url: '/mcp/g',
    path: '/mcp/g',
    get: (name: string) => (name.toLowerCase() === 'host' ? 'hub.example' : undefined),
  };
  await handleSseConnection(req as unknown as Request, res as unknown as Response);
  return res;
};

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  resetLastUsedThrottle();
  keys = [userKey()];
  setConfig({
    routing: { enableBearerAuth: true, enableGlobalRoute: true },
    workspace: workspaceOn(),
  });
  keyUpdate.mockClear();
  tokenUpdate.mockClear();
  mockTransport.close.mockClear().mockResolvedValue(undefined);
  Object.keys(transports).forEach((id) => delete transports[id]);
  (mcpService.getMcpServer as jest.Mock).mockReturnValue({ connect: jest.fn() });
  (mcpService.deleteMcpServer as jest.Mock).mockReset();
  (resolveOAuthGrantFromToken as jest.Mock).mockReset().mockResolvedValue(null);
  (daoIndex.getSystemConfigDao as jest.Mock).mockReturnValue({ get: async () => systemConfig });
  (daoIndex.getBearerKeyDao as jest.Mock).mockReturnValue({
    findEnabled: async () => keys.filter((k) => k.enabled),
    recordLastUsed: async (id: string, at: string) => {
      keyUpdate(id, { lastUsedAt: at });
    },
  });
  (daoIndex.getOAuthTokenDao as jest.Mock).mockReturnValue({
    recordLastUsed: async (accessToken: string, at: string) => {
      tokenUpdate(accessToken, { lastUsedAt: at });
    },
  });
  (daoIndex.getGroupDao as jest.Mock).mockReturnValue({
    findByName: async () => null,
    findById: async () => null,
  });
  (daoIndex.getUserDao as jest.Mock).mockReturnValue({
    findByUsername: async (username: string) =>
      username === 'alice' ? { username: 'alice', password: '', isAdmin: false } : null,
  });
});
afterEach(() => jest.useRealTimers());

const flush = () => Promise.resolve().then(() => Promise.resolve());

describe('last use on MCP authentication', () => {
  it('stamps a user key once per minute and records the session credential', async () => {
    const res = await connect('user-key-secret');
    await flush();
    expect(res.status).not.toHaveBeenCalled();
    expect(keyUpdate).toHaveBeenCalledTimes(1);
    expect(keyUpdate).toHaveBeenCalledWith('key-1', { lastUsedAt: new Date(NOW).toISOString() });
    expect(transports['sess-1'].credential).toEqual({ kind: 'key', id: 'key-1' });

    await connect('user-key-secret');
    jest.advanceTimersByTime(30_000);
    await connect('user-key-secret');
    await flush();
    expect(keyUpdate).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(31_000);
    await connect('user-key-secret');
    await flush();
    expect(keyUpdate).toHaveBeenCalledTimes(2);
  });

  it('stamps the OAuth access token and records the client on the session', async () => {
    (resolveOAuthGrantFromToken as jest.Mock).mockResolvedValue({
      user: { username: 'alice', password: '', isAdmin: false },
      clientId: 'client-a',
    });
    keys = [];
    const res = await connect('oauth-access-token');
    await flush();
    expect(res.status).not.toHaveBeenCalled();
    expect(tokenUpdate).toHaveBeenCalledWith('oauth-access-token', {
      lastUsedAt: new Date(NOW).toISOString(),
    });
    expect(transports['sess-1'].credential).toEqual({ kind: 'oauth', id: 'client-a' });
  });

  it('writes nothing when authentication fails', async () => {
    // Unknown token, owner mismatch on a user route, and an invalid OAuth token.
    expect((await connect('wrong')).status).toHaveBeenCalledWith(401);
    expect(
      (await connect('user-key-secret', { group: 'g', user: 'bob' })).status,
    ).toHaveBeenCalledWith(403);
    keys = [];
    expect((await connect('oauth-looking-token')).status).toHaveBeenCalledWith(401);
    await flush();
    expect(keyUpdate).not.toHaveBeenCalled();
    expect(tokenUpdate).not.toHaveBeenCalled();
    expect(Object.keys(transports)).toHaveLength(0);
  });

  it('writes no last-use stamp while the workspace is off', async () => {
    setConfig({ ...systemConfig, workspace: { enabled: false } });
    (resolveOAuthGrantFromToken as jest.Mock).mockResolvedValue({
      user: { username: 'alice', password: '', isAdmin: false },
      clientId: 'client-a',
    });
    await connect('user-key-secret');
    keys = [];
    await connect('oauth-access-token');
    await flush();
    expect(keyUpdate).not.toHaveBeenCalled();
    expect(tokenUpdate).not.toHaveBeenCalled();
  });

  it('stamps nothing for a system key', async () => {
    keys = [userKey({ kind: 'system', owner: undefined })];
    const res = await connect('user-key-secret');
    await flush();
    expect(res.status).not.toHaveBeenCalled();
    expect(keyUpdate).not.toHaveBeenCalled();
  });
});

describe('idle expiry of user keys', () => {
  const idleKey = () => userKey({ lastUsedAt: new Date(NOW - 31 * DAY).toISOString() });

  it('rejects an idle key exactly like a key that does not exist', async () => {
    setConfig({
      ...systemConfig,
      workspace: workspaceOn({ clientIdleDays: 30, enabledAt: LONG_AGO }),
    });
    keys = [idleKey()];
    const idle = await connect('user-key-secret');
    keys = [];
    const gone = await connect('user-key-secret');

    expect(idle.status).toHaveBeenCalledWith(401);
    expect(idle.json.mock.calls[0]).toEqual(gone.json.mock.calls[0]);
    expect(idle.setHeader.mock.calls).toEqual(gone.setHeader.mock.calls);
    await flush();
    expect(keyUpdate).not.toHaveBeenCalled();
  });

  it('honours the default window, and a recent key still works', async () => {
    setConfig({ ...systemConfig, workspace: workspaceOn({ enabledAt: LONG_AGO }) });
    keys = [userKey({ lastUsedAt: new Date(NOW - 89 * DAY).toISOString() })];
    expect((await connect('user-key-secret')).status).not.toHaveBeenCalled();
    keys = [userKey({ lastUsedAt: new Date(NOW - 91 * DAY).toISOString() })];
    resetLastUsedThrottle();
    expect((await connect('user-key-secret')).status).toHaveBeenCalledWith(401);
  });

  it.each([
    ['clientIdleDays is 0', workspaceOn({ clientIdleDays: 0, enabledAt: LONG_AGO })],
    ['the workspace is off', { enabled: false, clientIdleDays: 30, enabledAt: LONG_AGO }],
    ['the workspace setting is absent', {}],
  ])('keeps accepting an old key when %s', async (_name, workspace) => {
    setConfig({ ...systemConfig, workspace });
    keys = [idleKey()];
    const res = await connect('user-key-secret');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('becomes idle once enough time passes on the clock', async () => {
    setConfig({
      ...systemConfig,
      workspace: workspaceOn({ clientIdleDays: 30, enabledAt: LONG_AGO }),
    });
    keys = [userKey({ lastUsedAt: new Date(NOW - 29 * DAY).toISOString() })];
    expect((await connect('user-key-secret')).status).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2 * DAY);
    resetLastUsedThrottle();
    expect((await connect('user-key-secret')).status).toHaveBeenCalledWith(401);
  });
});

describe('closing sessions of a revoked credential', () => {
  const session = (username: string, credential?: { kind: 'oauth' | 'key'; id: string }) => ({
    transport: { close: jest.fn().mockResolvedValue(undefined) } as any,
    group: 'g',
    username,
    credential,
  });

  it('closes only that user’s sessions opened with the credential', () => {
    transports.a = session('alice', { kind: 'oauth', id: 'client-a' });
    transports.b = session('alice', { kind: 'oauth', id: 'client-b' });
    transports.c = session('bob', { kind: 'oauth', id: 'client-a' });
    transports.d = session('alice', { kind: 'key', id: 'client-a' });
    transports.e = session('alice');
    const closed = [transports.a, transports.b, transports.c, transports.d, transports.e];

    expect(closeSessionsForCredential('alice', { kind: 'oauth', id: 'client-a' })).toBe(1);
    expect(closed[0].transport.close).toHaveBeenCalled();
    for (const other of closed.slice(1)) expect(other.transport.close).not.toHaveBeenCalled();
    expect(Object.keys(transports).sort()).toEqual(['b', 'c', 'd', 'e']);
  });

  it('closes every credentialed session of the user when no credential is given', () => {
    transports.a = session('alice', { kind: 'oauth', id: 'client-a' });
    transports.b = session('alice', { kind: 'key', id: 'key-1' });
    transports.c = session('bob', { kind: 'key', id: 'key-9' });
    transports.d = session('alice');
    expect(closeSessionsForCredential('alice')).toBe(2);
    expect(Object.keys(transports).sort()).toEqual(['c', 'd']);
  });
});
