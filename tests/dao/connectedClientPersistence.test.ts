import fs from 'fs';
import os from 'os';
import path from 'path';

let cachedConfig: Record<string, unknown> | null = { workspace: { enabled: true } };
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: () => cachedConfig,
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: () => false,
}));

const tokenRepo = {
  recordLastUsed: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  findByUsername: jest.fn(),
  revokeUserClientTokens: jest.fn(),
};
const keyRepo = {
  recordLastUsed: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  findByOwner: jest.fn(),
  findById: jest.fn(),
};
jest.mock('../../src/db/repositories/OAuthTokenRepository.js', () => ({
  OAuthTokenRepository: jest.fn(() => tokenRepo),
}));
jest.mock('../../src/db/repositories/BearerKeyRepository.js', () => ({
  BearerKeyRepository: jest.fn(() => keyRepo),
}));

import { BearerKeyDaoImpl } from '../../src/dao/BearerKeyDao.js';
import { BearerKeyDaoDbImpl } from '../../src/dao/BearerKeyDaoDbImpl.js';
import { OAuthTokenDaoImpl } from '../../src/dao/OAuthTokenDao.js';
import { OAuthTokenDaoDbImpl } from '../../src/dao/OAuthTokenDaoDbImpl.js';
import { resetUsageStoreCache, usageKeyForToken } from '../../src/dao/clientUsageStore.js';

describe('JSON mode', () => {
  let dir: string;
  let settingsPath: string;
  let previous: string | undefined;

  beforeEach(() => {
    cachedConfig = { workspace: { enabled: true } };
    resetUsageStoreCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-clients-'));
    settingsPath = path.join(dir, 'mcp_settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ mcpServers: {}, bearerKeys: [], oauthTokens: [] }),
    );
    previous = process.env.MCPHUB_SETTING_PATH;
    process.env.MCPHUB_SETTING_PATH = settingsPath;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.MCPHUB_SETTING_PATH;
    else process.env.MCPHUB_SETTING_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const stored = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  it('stamps createdAt on new keys and keeps last use in the sidecar, not in settings', async () => {
    const dao = new BearerKeyDaoImpl();
    const key = await dao.create({
      name: 'laptop',
      token: 't',
      enabled: true,
      kind: 'user',
      owner: 'alice',
      accessType: 'all',
    });
    expect(Number.isNaN(Date.parse(key.createdAt!))).toBe(false);
    expect(key.lastUsedAt).toBeUndefined();

    const settingsBefore = fs.readFileSync(settingsPath, 'utf8');
    await dao.recordLastUsed(key.id, '2026-06-01T00:00:00.000Z');

    // mcp_settings.json is untouched; the stamp is in <settings>.usage.json, keyed by key id.
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settingsBefore);
    expect(JSON.parse(fs.readFileSync(`${settingsPath}.usage.json`, 'utf8'))).toEqual({
      [`key:${key.id}`]: '2026-06-01T00:00:00.000Z',
    });
    expect((await dao.findByOwner('alice'))[0].lastUsedAt).toBe('2026-06-01T00:00:00.000Z');
    resetUsageStoreCache(); // a restart reads it back from disk
    expect((await new BearerKeyDaoImpl().findByOwner('alice'))[0].lastUsedAt).toBe(
      '2026-06-01T00:00:00.000Z',
    );

    // Later unrelated writes neither copy the stamp into settings nor lose it.
    await dao.update(key.id, { name: 'renamed' });
    expect(stored().bearerKeys[0].lastUsedAt).toBeUndefined();
    expect((await dao.findById(key.id))!.lastUsedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('drops the sidecar entry of a deleted key', async () => {
    const dao = new BearerKeyDaoImpl();
    const key = await dao.create({
      name: 'k',
      token: 't',
      enabled: true,
      kind: 'user',
      owner: 'a',
      accessType: 'all',
    });
    await dao.recordLastUsed(key.id, '2026-06-01T00:00:00.000Z');
    await dao.delete(key.id);
    expect(JSON.parse(fs.readFileSync(`${settingsPath}.usage.json`, 'utf8'))).toEqual({});
  });

  it('keeps an explicit createdAt and leaves legacy keys without one', async () => {
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        mcpServers: {},
        bearerKeys: [
          {
            id: 'old',
            name: 'old',
            token: 't',
            enabled: true,
            kind: 'user',
            owner: 'a',
            accessType: 'all',
          },
        ],
      }),
    );
    const dao = new BearerKeyDaoImpl();
    expect((await dao.findById('old'))!.createdAt).toBeUndefined();
    const created = await dao.create({
      name: 'n',
      token: 't2',
      enabled: true,
      accessType: 'all',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
    expect(created.createdAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('persists OAuth lastUsedAt and grantCreatedAt, and revokes one client for one user', async () => {
    const dao = new OAuthTokenDaoImpl();
    const base = {
      accessTokenExpiresAt: new Date(Date.now() + 3600_000),
      refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    };
    await dao.create({
      ...base,
      accessToken: 'a1',
      refreshToken: 'r1',
      clientId: 'c1',
      username: 'alice',
      grantCreatedAt: '2026-01-01T00:00:00.000Z',
    });
    await dao.create({
      ...base,
      accessToken: 'a2',
      refreshToken: 'r2',
      clientId: 'c2',
      username: 'alice',
    });
    await dao.create({
      ...base,
      accessToken: 'a3',
      refreshToken: 'r3',
      clientId: 'c1',
      username: 'bob',
    });

    const before = fs.readFileSync(settingsPath, 'utf8');
    await dao.recordLastUsed('a1', '2026-06-01T00:00:00.000Z');
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    expect((await dao.findByAccessToken('a1'))!).toMatchObject({
      lastUsedAt: '2026-06-01T00:00:00.000Z',
      grantCreatedAt: '2026-01-01T00:00:00.000Z',
    });

    // The sidecar is keyed by a digest, never by the token itself, and nothing else holds it.
    const sidecar = fs.readFileSync(`${settingsPath}.usage.json`, 'utf8');
    expect(Object.keys(JSON.parse(sidecar))).toEqual([usageKeyForToken('a1')]);
    expect(sidecar).not.toContain('a1"');
    expect(sidecar).not.toContain('r1');

    // A rotated record created with an inherited last use keeps it, also outside settings.
    await dao.create({
      ...base,
      accessToken: 'a4',
      refreshToken: 'r4',
      clientId: 'c1',
      username: 'alice',
      lastUsedAt: '2026-05-01T00:00:00.000Z',
    });
    expect((await dao.findByAccessToken('a4'))!.lastUsedAt).toBe('2026-05-01T00:00:00.000Z');
    expect(JSON.stringify(stored().oauthTokens)).not.toContain('lastUsedAt');
    await dao.revokeToken('a4');

    expect(await dao.revokeUserClientTokens('alice', 'c1')).toBe(1);
    expect((await dao.findAll()).map((t) => t.accessToken).sort()).toEqual(['a2', 'a3']);
    expect(fs.readFileSync(`${settingsPath}.usage.json`, 'utf8')).not.toContain(
      usageKeyForToken('a1'),
    );
    expect(await dao.revokeUserClientTokens('alice', 'c1')).toBe(0);
  });
});

describe('JSON mode sidecar safety', () => {
  let dir: string;
  let settingsPath: string;
  let previous: string | undefined;
  const base = {
    accessTokenExpiresAt: new Date(Date.now() + 3600_000),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
  };

  beforeEach(() => {
    cachedConfig = { workspace: { enabled: true } };
    resetUsageStoreCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-clients-'));
    settingsPath = path.join(dir, 'mcp_settings.json');
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ mcpServers: {}, bearerKeys: [], oauthTokens: [] }),
    );
    previous = process.env.MCPHUB_SETTING_PATH;
    process.env.MCPHUB_SETTING_PATH = settingsPath;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (previous === undefined) delete process.env.MCPHUB_SETTING_PATH;
    else process.env.MCPHUB_SETTING_PATH = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes no sidecar on create, refresh carry-over, revoke or save while the mode is off', async () => {
    cachedConfig = { workspace: { enabled: false } };
    const tokens = new OAuthTokenDaoImpl();
    const keys = new BearerKeyDaoImpl();
    await tokens.create({
      ...base,
      accessToken: 'a',
      refreshToken: 'r',
      clientId: 'c',
      username: 'u',
      lastUsedAt: '2026-05-01T00:00:00.000Z',
    });
    await tokens.update('a', { lastUsedAt: '2026-05-02T00:00:00.000Z' });
    await tokens.recordLastUsed('a', '2026-05-03T00:00:00.000Z');
    await tokens.revokeUserClientTokens('u', 'c');
    const key = await keys.create({
      name: 'k',
      token: 't',
      enabled: true,
      kind: 'user',
      owner: 'u',
      accessType: 'all',
    });
    await keys.recordLastUsed(key.id, '2026-05-03T00:00:00.000Z');
    await keys.delete(key.id);
    expect(fs.existsSync(`${settingsPath}.usage.json`)).toBe(false);
  });

  it('never fails a credential operation when the sidecar cannot be written', async () => {
    jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('.usage.json')) throw new Error('EACCES');
      return jest.requireActual('fs').renameSync(from, to);
    });
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const tokens = new OAuthTokenDaoImpl();
    const keys = new BearerKeyDaoImpl();

    // A refresh-style create carrying a last use, a stamp, an update, and revokes.
    await expect(
      tokens.create({
        ...base,
        accessToken: 'a',
        refreshToken: 'r',
        clientId: 'c',
        username: 'u',
        lastUsedAt: '2026-05-01T00:00:00.000Z',
      }),
    ).resolves.toMatchObject({ accessToken: 'a' });
    await expect(tokens.recordLastUsed('a', '2026-05-02T00:00:00.000Z')).resolves.toBeUndefined();
    await expect(
      tokens.update('a', { lastUsedAt: '2026-05-03T00:00:00.000Z', scope: 'read' }),
    ).resolves.toMatchObject({ scope: 'read' });
    expect(await tokens.revokeUserClientTokens('u', 'c')).toBe(1);

    const key = await keys.create({
      name: 'k',
      token: 't',
      enabled: true,
      kind: 'user',
      owner: 'u',
      accessType: 'all',
      lastUsedAt: '2026-05-01T00:00:00.000Z',
    });
    await expect(keys.recordLastUsed(key.id, '2026-05-02T00:00:00.000Z')).resolves.toBeUndefined();
    await expect(keys.update(key.id, { name: 'renamed' })).resolves.toMatchObject({
      name: 'renamed',
    });
    expect(await keys.delete(key.id)).toBe(true);
  });

  it('survives an unreadable sidecar when reading credentials', async () => {
    fs.writeFileSync(`${settingsPath}.usage.json`, '{ not json');
    const tokens = new OAuthTokenDaoImpl();
    await tokens.create({
      ...base,
      accessToken: 'a',
      refreshToken: 'r',
      clientId: 'c',
      username: 'u',
    });
    expect((await tokens.findAll())[0].accessToken).toBe('a');
  });
});

describe('database mode', () => {
  beforeEach(() => jest.clearAllMocks());

  it('maps bearer key createdAt and lastUsedAt both ways', async () => {
    const entity = {
      id: 'k',
      name: 'laptop',
      token: 't',
      enabled: true,
      kind: 'user',
      owner: 'alice',
      accessType: 'all',
      allowedGroups: [],
      allowedServers: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    keyRepo.findByOwner.mockResolvedValue([entity]);
    keyRepo.update.mockResolvedValue(entity);
    keyRepo.create.mockResolvedValue({ ...entity, lastUsedAt: null });
    const dao = new BearerKeyDaoDbImpl();

    expect(await dao.findByOwner('alice')).toEqual([
      expect.objectContaining({
        createdAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    // Last use goes through the targeted write, never through the read-merge-save update.
    await dao.recordLastUsed('k', '2026-06-02T00:00:00.000Z');
    expect(keyRepo.recordLastUsed).toHaveBeenCalledWith('k', new Date('2026-06-02T00:00:00.000Z'));
    expect(keyRepo.update).not.toHaveBeenCalled();
    expect(
      (await dao.create({ name: 'n', token: 't', enabled: true, accessType: 'all' })).lastUsedAt,
    ).toBeUndefined();
  });

  it('maps OAuth token grantCreatedAt and lastUsedAt, and revokes per user and client', async () => {
    const row = {
      accessToken: 'a',
      accessTokenExpiresAt: new Date(),
      clientId: 'c',
      username: 'alice',
      grantCreatedAt: new Date('2026-01-01T00:00:00.000Z'),
      lastUsedAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    tokenRepo.create.mockResolvedValue(row);
    tokenRepo.update.mockResolvedValue(row);
    tokenRepo.findByUsername.mockResolvedValue([row]);
    tokenRepo.revokeUserClientTokens.mockResolvedValue(2);
    const dao = new OAuthTokenDaoDbImpl();

    await dao.create({
      accessToken: 'a',
      accessTokenExpiresAt: row.accessTokenExpiresAt,
      clientId: 'c',
      username: 'alice',
      grantCreatedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-06-01T00:00:00.000Z',
    });
    expect(tokenRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        grantCreatedAt: row.grantCreatedAt,
        lastUsedAt: row.lastUsedAt,
      }),
    );
    await dao.recordLastUsed('a', '2026-06-02T00:00:00.000Z');
    expect(tokenRepo.recordLastUsed).toHaveBeenCalledWith(
      'a',
      new Date('2026-06-02T00:00:00.000Z'),
    );
    expect(tokenRepo.update).not.toHaveBeenCalled();
    expect(await dao.findByUsername('alice')).toEqual([
      expect.objectContaining({
        grantCreatedAt: '2026-01-01T00:00:00.000Z',
        lastUsedAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);
    expect(await dao.revokeUserClientTokens('alice', 'c')).toBe(2);
    expect(tokenRepo.revokeUserClientTokens).toHaveBeenCalledWith('alice', 'c');
  });
});
