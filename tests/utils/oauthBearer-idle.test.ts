let cachedConfig: Record<string, unknown> | null = null;
let stored: Record<string, unknown> | undefined;

jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: () => cachedConfig,
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: () => false,
}));
jest.mock('../../src/services/oauthServerService.js', () => ({ isOAuthServerEnabled: () => true }));
jest.mock('../../src/models/OAuth.js', () => ({ getToken: async () => stored }));
jest.mock('../../src/utils/userSession.js', () => ({
  resolveUserSession: async () => ({ username: 'alice', password: 'x', isAdmin: false }),
}));

import { resolveOAuthGrantFromToken } from '../../src/utils/oauthBearer.js';

const DAY = 24 * 60 * 60 * 1000;
const LONG_AGO = '2020-01-01T00:00:00.000Z';

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
  stored = {
    accessToken: 'tok',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    clientId: 'client-a',
    username: 'alice',
    sessionVersion: 'v',
    grantCreatedAt: new Date(Date.now() - 200 * DAY).toISOString(),
    lastUsedAt: new Date(Date.now() - 40 * DAY).toISOString(),
  };
});
afterEach(() => jest.useRealTimers());

describe('OAuth bearer idle expiry', () => {
  it('returns the user and client while the grant is active', async () => {
    cachedConfig = { workspace: { enabled: true, clientIdleDays: 90, enabledAt: LONG_AGO } };
    await expect(resolveOAuthGrantFromToken('tok')).resolves.toEqual({
      user: { username: 'alice', password: '', isAdmin: false },
      clientId: 'client-a',
    });
  });

  it('rejects a grant idle past the window as if the token were unknown', async () => {
    cachedConfig = { workspace: { enabled: true, clientIdleDays: 30, enabledAt: LONG_AGO } };
    await expect(resolveOAuthGrantFromToken('tok')).resolves.toBeNull();
    // Reference point: a token the store does not know answers the same way.
    stored = undefined;
    await expect(resolveOAuthGrantFromToken('tok')).resolves.toBeNull();
  });

  it('does not expire a long-unused grant right after the mode is enabled, then measures from there', async () => {
    stored!.lastUsedAt = undefined;
    cachedConfig = {
      workspace: { enabled: true, clientIdleDays: 30, enabledAt: new Date().toISOString() },
    };
    await expect(resolveOAuthGrantFromToken('tok')).resolves.not.toBeNull();
    jest.advanceTimersByTime(31 * DAY);
    await expect(resolveOAuthGrantFromToken('tok')).resolves.toBeNull();
  });

  it('becomes idle as time passes', async () => {
    cachedConfig = { workspace: { enabled: true, clientIdleDays: 60, enabledAt: LONG_AGO } };
    await expect(resolveOAuthGrantFromToken('tok')).resolves.not.toBeNull();
    jest.advanceTimersByTime(21 * DAY);
    await expect(resolveOAuthGrantFromToken('tok')).resolves.toBeNull();
  });

  it.each([
    ['clientIdleDays is 0', { workspace: { enabled: true, clientIdleDays: 0 } }],
    ['the workspace is off', { workspace: { enabled: false, clientIdleDays: 1 } }],
    ['no workspace config', null],
  ])('is not applied when %s', async (_name, config) => {
    cachedConfig = config;
    await expect(resolveOAuthGrantFromToken('tok')).resolves.not.toBeNull();
  });
});
