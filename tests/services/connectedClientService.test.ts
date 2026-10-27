import type { BearerKey, IOAuthClient, IOAuthToken, SystemConfig } from '../../src/types/index.js';

let tokens: IOAuthToken[];
let keys: BearerKey[];
let clients: IOAuthClient[];
let cachedConfig: SystemConfig | null;
let storedConfig: SystemConfig | null;
const closeSessions = jest.fn();
const tokenUsage = jest.fn();
const keyUsage = jest.fn();
const configUpdate = jest.fn();

jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: () => cachedConfig,
  setCachedSystemConfig: (config: SystemConfig) => {
    cachedConfig = config;
  },
  isDatabaseModeEnabled: () => false,
}));
jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({
    get: async () => storedConfig,
    update: async (config: SystemConfig) => {
      configUpdate(config);
      storedConfig = config;
      return config;
    },
  }),
  getOAuthTokenDao: () => ({
    findByUsername: async (username: string) => tokens.filter((t) => t.username === username),
    recordLastUsed: async (accessToken: string, at: string) => {
      tokenUsage(accessToken, at);
      const token = tokens.find((t) => t.accessToken === accessToken);
      if (token) token.lastUsedAt = at;
    },
    revokeUserClientTokens: async (username: string, clientId: string) => {
      const before = tokens.length;
      tokens = tokens.filter((t) => !(t.username === username && t.clientId === clientId));
      return before - tokens.length;
    },
    revokeUserTokens: async (username: string) => {
      const before = tokens.length;
      tokens = tokens.filter((t) => t.username !== username);
      return before - tokens.length;
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
    recordLastUsed: async (id: string, at: string) => {
      keyUsage(id, at);
      const key = keys.find((k) => k.id === id);
      if (key) key.lastUsedAt = at;
    },
    delete: async (id: string) => {
      const before = keys.length;
      keys = keys.filter((k) => k.id !== id);
      return keys.length < before;
    },
    deleteByOwner: async (owner: string) => {
      keys = keys.filter((k) => !(k.kind === 'user' && k.owner === owner));
      return 0;
    },
  }),
}));
jest.mock('../../src/services/sseService.js', () => ({
  closeSessionsForCredential: (...args: unknown[]) => closeSessions(...args),
}));

import {
  ensureWorkspaceEnabledAt,
  isKeyIdle,
  isOAuthTokenIdle,
  listConnectedClients,
  recordBearerKeyUse,
  recordOAuthTokenUse,
  resetLastUsedThrottle,
  revokeAllConnectedClients,
  revokeConnectedClient,
} from '../../src/services/connectedClientService.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-06-01T00:00:00.000Z').getTime();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
// enabledAt defaults to long ago, so tests of the window itself are not clamped by it.
const on = (clientIdleDays?: number, enabledAt: string = iso(-1000 * DAY)): SystemConfig => ({
  workspace: {
    enabled: true,
    enabledAt,
    ...(clientIdleDays === undefined ? {} : { clientIdleDays }),
  },
});

const token = (overrides: Partial<IOAuthToken> = {}): IOAuthToken => ({
  accessToken: 'secret-access',
  accessTokenExpiresAt: new Date(NOW + 3600_000),
  refreshToken: 'secret-refresh',
  refreshTokenExpiresAt: new Date(NOW + 14 * DAY),
  clientId: 'client-a',
  username: 'alice',
  scope: 'read write',
  grantCreatedAt: iso(-500 * DAY),
  ...overrides,
});

const userKey = (overrides: Partial<BearerKey> = {}): BearerKey => ({
  id: 'key-1',
  name: 'laptop',
  token: 'secret-key-value',
  enabled: true,
  kind: 'user',
  owner: 'alice',
  accessType: 'all',
  createdAt: iso(-500 * DAY),
  ...overrides,
});

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  tokens = [];
  keys = [];
  clients = [];
  resetLastUsedThrottle();
  cachedConfig = on();
  storedConfig = on();
  closeSessions.mockClear();
  tokenUsage.mockClear();
  keyUsage.mockClear();
  configUpdate.mockClear();
});
afterEach(() => jest.useRealTimers());

describe('idle expiry', () => {
  it('rejects a key unused for longer than the window, using lastUsedAt over createdAt', () => {
    const key = userKey({ createdAt: iso(-200 * DAY), lastUsedAt: iso(-89 * DAY) });
    expect(isKeyIdle(key, on(90), NOW)).toBe(false);
    expect(isKeyIdle({ ...key, lastUsedAt: iso(-91 * DAY) }, on(90), NOW)).toBe(true);
  });

  it('falls back to creation time when never used', () => {
    expect(isKeyIdle(userKey({ createdAt: iso(-91 * DAY) }), on(90), NOW)).toBe(true);
    expect(isKeyIdle(userKey({ createdAt: iso(-10 * DAY) }), on(90), NOW)).toBe(false);
  });

  it('defaults to 90 days and honours a configured window', () => {
    const key = userKey({ lastUsedAt: iso(-45 * DAY) });
    expect(isKeyIdle(key, on(), NOW)).toBe(false);
    expect(isKeyIdle(key, on(30), NOW)).toBe(true);
    expect(isKeyIdle(userKey({ lastUsedAt: iso(-91 * DAY) }), on(), NOW)).toBe(true);
    expect(isKeyIdle(userKey({ lastUsedAt: iso(-91 * DAY) }), on(-5), NOW)).toBe(true);
  });

  it('never expires existing credentials just because the workspace was enabled', () => {
    // Keys and grants created 200 days ago, never used, mode switched on right now.
    const fresh = on(90, iso(0));
    expect(isKeyIdle(userKey({ createdAt: iso(-200 * DAY) }), fresh, NOW)).toBe(false);
    expect(
      isKeyIdle(userKey({ createdAt: iso(-200 * DAY), lastUsedAt: iso(-150 * DAY) }), fresh, NOW),
    ).toBe(false);
    expect(isKeyIdle(userKey({ createdAt: undefined }), fresh, NOW)).toBe(false);
    expect(isOAuthTokenIdle(token({ grantCreatedAt: iso(-200 * DAY) }), fresh, NOW)).toBe(false);
  });

  it('measures idle time from the moment the mode was enabled', () => {
    const enabled = on(90, iso(0));
    const old = userKey({ createdAt: iso(-200 * DAY) });
    const dayAt = (days: number) => NOW + days * DAY;
    expect(isKeyIdle(old, enabled, dayAt(89))).toBe(false);
    expect(isKeyIdle(old, enabled, dayAt(91))).toBe(true);
    // A key with no creation date gets its clock from enabledAt too.
    expect(isKeyIdle(userKey({ createdAt: undefined }), enabled, dayAt(91))).toBe(true);
    // Use after enabling restarts the clock.
    const used = userKey({ createdAt: undefined, lastUsedAt: iso(50 * DAY) });
    expect(isKeyIdle(used, enabled, dayAt(100))).toBe(false);
    expect(isKeyIdle(used, enabled, dayAt(141))).toBe(true);
    expect(isOAuthTokenIdle(token({ grantCreatedAt: iso(-200 * DAY) }), enabled, dayAt(91))).toBe(
      true,
    );
  });

  it('treats an enabledAt in the future as now, so nothing expires until it is re-stamped', () => {
    const future = on(90, iso(500 * DAY));
    const old = userKey({ createdAt: iso(-200 * DAY) });
    expect(isKeyIdle(old, future, NOW)).toBe(false);
    expect(isKeyIdle(old, future, NOW + 365 * DAY)).toBe(false);
  });

  it('does not apply until the mode has an enabledAt', () => {
    const unstamped: SystemConfig = { workspace: { enabled: true, clientIdleDays: 1 } };
    expect(isKeyIdle(userKey({ createdAt: iso(-200 * DAY) }), unstamped, NOW)).toBe(false);
  });

  it('is disabled by 0 and while the workspace is off', () => {
    const stale = userKey({ lastUsedAt: iso(-1000 * DAY) });
    expect(isKeyIdle(stale, on(0), NOW)).toBe(false);
    expect(isKeyIdle(stale, { workspace: { enabled: false, clientIdleDays: 1 } }, NOW)).toBe(false);
    expect(isKeyIdle(stale, {}, NOW)).toBe(false);
    expect(isKeyIdle(stale, null, NOW)).toBe(false);
  });

  it('never expires system keys', () => {
    expect(isKeyIdle(userKey({ kind: 'system', lastUsedAt: iso(-1000 * DAY) }), on(1), NOW)).toBe(
      false,
    );
  });

  it('applies the same rule to OAuth grants, dating legacy records from their access token', () => {
    expect(isOAuthTokenIdle(token({ lastUsedAt: iso(-91 * DAY) }), on(90), NOW)).toBe(true);
    expect(isOAuthTokenIdle(token({ lastUsedAt: iso(-5 * DAY) }), on(90), NOW)).toBe(false);
    expect(isOAuthTokenIdle(token({ grantCreatedAt: iso(-95 * DAY) }), on(90), NOW)).toBe(true);
    // Idle is a property of the window, never of lineage: a very old grant, used recently, is fine.
    expect(
      isOAuthTokenIdle(
        token({ grantCreatedAt: iso(-900 * DAY), lastUsedAt: iso(-1 * DAY) }),
        on(90),
        NOW,
      ),
    ).toBe(false);
    // No stamps: created = expiry (+1h) minus the default 1h lifetime = now.
    expect(isOAuthTokenIdle(token({ grantCreatedAt: undefined }), on(90), NOW)).toBe(false);
    expect(
      isOAuthTokenIdle(
        token({ grantCreatedAt: undefined, accessTokenExpiresAt: new Date(NOW - 100 * DAY) }),
        on(90),
        NOW,
      ),
    ).toBe(true);
    expect(isOAuthTokenIdle(token({ lastUsedAt: iso(-999 * DAY) }), on(0), NOW)).toBe(false);
    expect(isOAuthTokenIdle(token({ lastUsedAt: iso(-999 * DAY) }), {}, NOW)).toBe(false);
  });
});

describe('last use recording', () => {
  it('writes at most once per credential per 60 seconds', async () => {
    keys = [userKey()];
    await recordBearerKeyUse('key-1');
    await recordBearerKeyUse('key-1');
    jest.advanceTimersByTime(59_000);
    await recordBearerKeyUse('key-1');
    expect(keyUsage).toHaveBeenCalledTimes(1);
    expect(keyUsage).toHaveBeenCalledWith('key-1', iso(0));

    jest.advanceTimersByTime(2_000);
    await recordBearerKeyUse('key-1');
    expect(keyUsage).toHaveBeenCalledTimes(2);
    expect(keys[0].lastUsedAt).toBe(iso(61_000));
  });

  it('throttles each credential on its own', async () => {
    await recordBearerKeyUse('key-1');
    await recordBearerKeyUse('key-2');
    await recordOAuthTokenUse('access-1');
    await recordOAuthTokenUse('access-2');
    await recordOAuthTokenUse('access-1');
    expect(keyUsage).toHaveBeenCalledTimes(2);
    expect(tokenUsage).toHaveBeenCalledTimes(2);
  });

  it('stamps the access token record and never throws when storage fails', async () => {
    tokens = [token()];
    await recordOAuthTokenUse('secret-access');
    expect(tokens[0].lastUsedAt).toBe(iso(0));

    tokenUsage.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    resetLastUsedThrottle();
    await expect(recordOAuthTokenUse('other-access')).resolves.toBeUndefined();
  });
});

describe('last use is only tracked while the workspace is on', () => {
  it.each([null, {}, { workspace: { enabled: false } }])(
    'writes nothing when config is %j',
    async (cfg) => {
      cachedConfig = cfg as SystemConfig | null;
      tokens = [token()];
      keys = [userKey()];
      await recordBearerKeyUse('key-1');
      await recordOAuthTokenUse('secret-access');
      expect(keyUsage).not.toHaveBeenCalled();
      expect(tokenUsage).not.toHaveBeenCalled();
      expect(configUpdate).not.toHaveBeenCalled();
    },
  );

  it('stamps enabledAt first when the mode was switched on without one', async () => {
    cachedConfig = { workspace: { enabled: true } };
    storedConfig = { workspace: { enabled: true } };
    keys = [userKey()];
    await Promise.all([recordBearerKeyUse('key-1'), recordBearerKeyUse('key-2')]);
    expect(configUpdate).toHaveBeenCalledTimes(1);
    expect(cachedConfig!.workspace!.enabledAt).toBe(iso(0));
    expect(keyUsage).toHaveBeenCalledTimes(2);
  });

  it('adopts an enabledAt another instance already stored instead of writing its own', async () => {
    cachedConfig = { workspace: { enabled: true } };
    storedConfig = { workspace: { enabled: true, enabledAt: iso(-3 * DAY) } };
    await ensureWorkspaceEnabledAt();
    expect(configUpdate).not.toHaveBeenCalled();
    expect(cachedConfig!.workspace!.enabledAt).toBe(iso(-3 * DAY));
  });

  it.each(['garbage', '2999-01-01T00:00:00.000Z'])(
    're-stamps an invalid enabledAt (%s)',
    async (bad) => {
      cachedConfig = { workspace: { enabled: true, enabledAt: bad } };
      storedConfig = { workspace: { enabled: true, enabledAt: bad } };
      await ensureWorkspaceEnabledAt();
      expect(configUpdate).toHaveBeenCalledTimes(1);
      expect(cachedConfig!.workspace!.enabledAt).toBe(iso(0));
    },
  );

  it('leaves an existing enabledAt alone', async () => {
    await ensureWorkspaceEnabledAt();
    expect(configUpdate).not.toHaveBeenCalled();
  });
});

describe('listing', () => {
  it('lists one entry per OAuth client for the caller only, never secrets', async () => {
    clients = [
      { clientId: 'client-a', name: 'Claude Desktop', redirectUris: [], grants: [] },
      { clientId: 'client-b', name: '  ', redirectUris: [], grants: [] },
    ];
    tokens = [
      token({
        accessToken: 'a1',
        refreshToken: 'r1',
        grantCreatedAt: iso(-5 * DAY),
        lastUsedAt: iso(-3600_000),
      }),
      token({
        accessToken: 'a2',
        refreshToken: 'r2',
        grantCreatedAt: iso(-5 * DAY),
        lastUsedAt: iso(-60_000),
        scope: 'read',
      }),
      token({ accessToken: 'b1', refreshToken: 'rb1', clientId: 'client-b' }),
      token({ accessToken: 'x1', refreshToken: 'rx1', username: 'bob', clientId: 'client-c' }),
    ];
    keys = [
      userKey(),
      userKey({ id: 'key-2', owner: 'bob', name: 'bobs' }),
      userKey({ id: 'sys', kind: 'system', owner: undefined, name: 'system' }),
    ];

    const list = await listConnectedClients('alice', on(undefined, iso(-DAY)));
    expect(list.map((c) => `${c.kind}:${c.id}`).sort()).toEqual([
      'key:key-1',
      'oauth:client-a',
      'oauth:client-b',
    ]);
    const a = list.find((c) => c.id === 'client-a')!;
    expect(a).toMatchObject({
      name: 'Claude Desktop',
      clientId: 'client-a',
      createdAt: iso(-5 * DAY),
      lastUsedAt: iso(-60_000),
      expiresAt: iso(14 * DAY),
      scopes: ['read', 'write'],
    });
    expect(list.find((c) => c.id === 'client-b')!.name).toBe('client-b');
    expect(list.find((c) => c.id === 'client-b')!.lastUsedAt).toBeNull();
    expect(list.find((c) => c.id === 'key-1')).toMatchObject({
      kind: 'key',
      name: 'laptop',
      enabled: true,
      lastUsedAt: null,
      idle: false,
    });

    const serialized = JSON.stringify(list);
    for (const secret of [
      'a1',
      'r1',
      'a2',
      'secret-access',
      'secret-refresh',
      'secret-key-value',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('bob');
  });

  it('omits expired grants, flags idle ones, and reports no expiry for an unbounded refresh token', async () => {
    tokens = [
      token({
        accessToken: 'old',
        refreshToken: 'old-r',
        clientId: 'expired',
        accessTokenExpiresAt: new Date(NOW - 1000),
        refreshTokenExpiresAt: new Date(NOW - 1000),
      }),
      token({
        accessToken: 'idle',
        refreshToken: 'idle-r',
        clientId: 'idle',
        lastUsedAt: iso(-100 * DAY),
      }),
      token({
        accessToken: 'forever',
        refreshToken: 'forever-r',
        clientId: 'forever',
        lastUsedAt: iso(-DAY),
        refreshTokenExpiresAt: undefined,
      }),
    ];
    keys = [
      userKey({ id: 'idle-key', lastUsedAt: iso(-100 * DAY) }),
      userKey({ id: 'live-key', lastUsedAt: iso(-1 * DAY) }),
    ];
    const list = await listConnectedClients('alice', on(90));
    expect(list.map((c) => `${c.id}:${c.idle}`).sort()).toEqual([
      'forever:false',
      'idle-key:true',
      'idle:true',
      'live-key:false',
    ]);
    expect(list.find((c) => c.id === 'forever')!.expiresAt).toBeUndefined();
  });

  it('keeps a client active while any one of its grants is active', async () => {
    tokens = [
      token({ accessToken: 'x1', refreshToken: 'rx1', lastUsedAt: iso(-100 * DAY) }),
      token({ accessToken: 'x2', refreshToken: 'rx2', lastUsedAt: iso(-1 * DAY) }),
    ];
    expect((await listConnectedClients('alice', on(90)))[0].idle).toBe(false);
  });
});

describe('revocation', () => {
  it('revokes one OAuth client for this user only', async () => {
    tokens = [
      token({ accessToken: 'a-alice', refreshToken: 'ra', clientId: 'client-a' }),
      token({ accessToken: 'b-alice', refreshToken: 'rb', clientId: 'client-b' }),
      token({ accessToken: 'a-bob', refreshToken: 'rc', clientId: 'client-a', username: 'bob' }),
    ];
    keys = [userKey()];

    expect(await revokeConnectedClient('alice', 'oauth', 'client-a')).toBe(true);
    expect(tokens.map((t) => t.accessToken).sort()).toEqual(['a-bob', 'b-alice']);
    expect(keys).toHaveLength(1);
    expect(closeSessions).toHaveBeenCalledWith('alice', { kind: 'oauth', id: 'client-a' });
  });

  it('revokes a user key and leaves other keys alone', async () => {
    keys = [userKey(), userKey({ id: 'key-2', name: 'phone' })];
    expect(await revokeConnectedClient('alice', 'key', 'key-1')).toBe(true);
    expect(keys.map((k) => k.id)).toEqual(['key-2']);
    expect(closeSessions).toHaveBeenCalledWith('alice', { kind: 'key', id: 'key-1' });
  });

  it('answers false the same way for another user, a system key, and a missing id', async () => {
    tokens = [token({ clientId: 'bobs', username: 'bob' })];
    keys = [
      userKey({ id: 'bobs-key', owner: 'bob' }),
      userKey({ id: 'sys', kind: 'system', owner: undefined }),
    ];
    expect(await revokeConnectedClient('alice', 'oauth', 'bobs')).toBe(false);
    expect(await revokeConnectedClient('alice', 'oauth', 'nothing')).toBe(false);
    expect(await revokeConnectedClient('alice', 'key', 'bobs-key')).toBe(false);
    expect(await revokeConnectedClient('alice', 'key', 'sys')).toBe(false);
    expect(await revokeConnectedClient('alice', 'key', 'nothing')).toBe(false);
    expect(tokens).toHaveLength(1);
    expect(keys).toHaveLength(2);
    expect(closeSessions).not.toHaveBeenCalled();
  });

  it('revokes everything the user has and nobody else’s', async () => {
    tokens = [
      token({ accessToken: 'a', refreshToken: 'ra' }),
      token({ accessToken: 'b', refreshToken: 'rb', clientId: 'client-b' }),
      token({ accessToken: 'c', refreshToken: 'rc', username: 'bob' }),
    ];
    keys = [
      userKey(),
      userKey({ id: 'key-b', owner: 'bob' }),
      userKey({ id: 'sys', kind: 'system', owner: undefined }),
    ];
    await revokeAllConnectedClients('alice');
    expect(tokens.map((t) => t.username)).toEqual(['bob']);
    expect(keys.map((k) => k.id).sort()).toEqual(['key-b', 'sys']);
    expect(closeSessions).toHaveBeenCalledWith('alice', undefined);
  });
});
