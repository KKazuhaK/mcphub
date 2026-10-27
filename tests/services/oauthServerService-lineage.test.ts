import type { IOAuthToken } from '../../src/types/index.js';

// The real models/OAuth and userSession run against an in-memory token store, so the merge of
// lineage fields and the revoke race are exercised end to end through the oauth2-server model.
const alice = { username: 'alice', password: 'hashed-pw', isAdmin: false };
let store: IOAuthToken[];
let createGate: Promise<void> | null;
let createStarted: (() => void) | null;
let cachedConfig: Record<string, unknown> | null;

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => ({
    findByUsername: async (username: string) => (username === 'alice' ? alice : null),
  }),
  getSystemConfigDao: () => ({ get: async () => ({}) }),
  getBearerKeyDao: jest.fn(),
  getOAuthClientDao: () => ({
    findByClientId: async (clientId: string) => ({
      clientId,
      redirectUris: [],
      grants: ['authorization_code', 'refresh_token'],
    }),
  }),
  getOAuthTokenDao: () => ({
    create: async (token: IOAuthToken) => {
      createStarted?.();
      if (createGate) await createGate;
      store.push({ ...token });
      return token;
    },
    findByAccessToken: async (v: string) => store.find((t) => t.accessToken === v) ?? null,
    findByRefreshToken: async (v: string) => store.find((t) => t.refreshToken === v) ?? null,
    revokeToken: async (v: string) => {
      const before = store.length;
      store = store.filter((t) => t.accessToken !== v && t.refreshToken !== v);
      return store.length < before;
    },
    revokeUserClientTokens: async (username: string, clientId: string) => {
      const before = store.length;
      store = store.filter((t) => !(t.username === username && t.clientId === clientId));
      return before - store.length;
    },
    revokeUserTokens: async (username: string) => {
      const before = store.length;
      store = store.filter((t) => t.username !== username);
      return before - store.length;
    },
  }),
}));
jest.mock('../../src/models/User.js', () => ({
  findUserByUsername: jest.fn(),
  verifyPassword: jest.fn(),
}));
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: () => cachedConfig,
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: () => false,
}));

import OAuth2Server from '@node-oauth/oauth2-server';
import { getOAuthModel } from '../../src/services/oauthServerService.js';
import { revokeUserClientTokens, revokeUserTokens, saveToken } from '../../src/models/OAuth.js';
import { getUserSessionVersion } from '../../src/utils/userSession.js';
import { resetGrantRevocations } from '../../src/utils/grantRevocation.js';

const model = getOAuthModel() as any;
const DAY = 24 * 60 * 60 * 1000;
const sessionVersion = getUserSessionVersion(alice);

const seed = async (extra: Partial<IOAuthToken> = {}, clientId = 'c') => {
  const token = await saveToken(
    { clientId, username: 'alice', sessionVersion, scope: 'read', ...extra },
    3600,
    14 * 86400,
  );
  return token;
};

// What oauth2-server does for a refresh grant: look the token up, revoke it, save the new one.
const refreshExchange = async (refreshToken: string, clientId = 'c') => {
  const found = await model.getRefreshToken(refreshToken);
  await model.revokeToken({ refreshToken });
  return model.saveToken({ scope: ['read'] }, { id: clientId }, found.user);
};

beforeEach(() => {
  store = [];
  createGate = null;
  createStarted = null;
  cachedConfig = null;
  resetGrantRevocations();
});

describe('grant lineage across refresh rotation', () => {
  it('carries the grant’s creation and last-use time into the rotated record', async () => {
    const old = new Date(Date.now() - 20 * DAY).toISOString();
    const used = new Date(Date.now() - 2 * DAY).toISOString();
    const first = await seed({ grantCreatedAt: old, lastUsedAt: used });

    const rotated = await refreshExchange(first.refreshToken!);

    expect(store).toHaveLength(1);
    expect(store[0].accessToken).toBe(rotated.accessToken);
    expect(store[0].accessToken).not.toBe(first.accessToken);
    expect(store[0].grantCreatedAt).toBe(old);
    expect(store[0].lastUsedAt).toBe(used);
  });

  it('dates a record from before grants were stamped by its own age, not by the refresh', async () => {
    const first = await seed();
    // Pre-upgrade shape: no grantCreatedAt, access token issued (and expired) 10 days ago.
    delete store[0].grantCreatedAt;
    store[0].accessTokenExpiresAt = new Date(Date.now() - 10 * DAY + 3600_000);

    await refreshExchange(first.refreshToken!);

    const created = Date.parse(store[0].grantCreatedAt!);
    expect(Math.abs(created - (Date.now() - 10 * DAY))).toBeLessThan(60_000);
  });

  it('starts a fresh grant for an authorization-code exchange', async () => {
    await model.saveToken({ scope: ['read'] }, { id: 'c' }, { username: 'alice', sessionVersion });
    expect(store).toHaveLength(1);
    expect(Math.abs(Date.parse(store[0].grantCreatedAt!) - Date.now())).toBeLessThan(5000);
    expect(store[0].lastUsedAt).toBeUndefined();
  });
});

describe('idle grants', () => {
  const idle = async () => {
    const token = await seed({
      grantCreatedAt: new Date(Date.now() - 300 * DAY).toISOString(),
      lastUsedAt: new Date(Date.now() - 100 * DAY).toISOString(),
    });
    return token;
  };
  const enabled = (extra: Record<string, unknown> = {}) => ({
    workspace: {
      enabled: true,
      enabledAt: '2020-01-01T00:00:00.000Z',
      clientIdleDays: 30,
      ...extra,
    },
  });

  it('refuses to refresh or to serve userinfo, like a revoked token', async () => {
    const token = await idle();
    cachedConfig = enabled();
    await expect(model.getRefreshToken(token.refreshToken)).resolves.toBe(false);
    await expect(model.getAccessToken(token.accessToken)).resolves.toBe(false);
  });

  it.each([
    ['clientIdleDays is 0', enabled({ clientIdleDays: 0 })],
    ['the workspace is off', { workspace: { enabled: false, clientIdleDays: 30 } }],
    ['there is no workspace config', null],
  ])('is not applied when %s', async (_name, config) => {
    const token = await idle();
    cachedConfig = config as Record<string, unknown> | null;
    await expect(model.getRefreshToken(token.refreshToken)).resolves.toMatchObject({
      refreshToken: token.refreshToken,
    });
    await expect(model.getAccessToken(token.accessToken)).resolves.toMatchObject({
      accessToken: token.accessToken,
    });
  });
});

describe('revoking while an exchange is in flight', () => {
  it('refuses a refresh that read its grant before the client was revoked', async () => {
    const first = await seed();
    const found = await model.getRefreshToken(first.refreshToken); // exchange has read the grant
    await revokeUserClientTokens('alice', 'c'); // the user revokes
    expect(store).toHaveLength(0);

    await expect(
      model.saveToken({ scope: ['read'] }, { id: 'c' }, found.user),
    ).rejects.toBeInstanceOf(OAuth2Server.InvalidGrantError);
    expect(store).toHaveLength(0);
  });

  it('does not block the user’s other clients or exchanges that started after the revoke', async () => {
    const other = await seed({}, 'other');
    const found = await model.getRefreshToken(other.refreshToken);
    await revokeUserClientTokens('alice', 'c');
    await expect(
      model.saveToken({ scope: ['read'] }, { id: 'other' }, found.user),
    ).resolves.toBeTruthy();

    const fresh = { username: 'alice', sessionVersion, exchangeSeq: undefined };
    await expect(model.saveToken({ scope: ['read'] }, { id: 'c' }, fresh)).resolves.toBeTruthy();
  });

  it('refuses a code exchange after revoke-all', async () => {
    // exchangeSeq is what getAuthorizationCode stamps on the user.
    const stamped = { username: 'alice', sessionVersion, exchangeSeq: 0 };
    await revokeUserTokens('alice');
    await expect(model.saveToken({ scope: ['read'] }, { id: 'c' }, stamped)).rejects.toBeInstanceOf(
      OAuth2Server.InvalidGrantError,
    );
    expect(store).toHaveLength(0);
  });

  it('takes the new token back when the revoke lands while it is being written', async () => {
    const first = await seed();
    const found = await model.getRefreshToken(first.refreshToken);
    await model.revokeToken({ refreshToken: first.refreshToken });

    let release!: () => void;
    createGate = new Promise<void>((resolve) => (release = resolve));
    const started = new Promise<void>((resolve) => (createStarted = resolve));

    const exchange = model.saveToken({ scope: ['read'] }, { id: 'c' }, found.user);
    exchange.catch(() => undefined);
    await started; // saveToken has passed its first check and is inside the DAO write
    await revokeUserClientTokens('alice', 'c');
    release();

    await expect(exchange).rejects.toBeInstanceOf(OAuth2Server.InvalidGrantError);
    expect(store).toHaveLength(0);
  });
});
