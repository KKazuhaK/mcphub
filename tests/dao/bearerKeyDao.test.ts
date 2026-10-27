import fs from 'fs';
import os from 'os';
import path from 'path';

import { BearerKeyDaoImpl } from '../../src/dao/BearerKeyDao.js';
import { generateBearerToken, hashBearerToken } from '../../src/utils/bearerKeyHash.js';

const writeSettings = (settingsPath: string, settings: unknown): void => {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
};

describe('BearerKeyDaoImpl migration + settings caching behavior', () => {
  let tmpDir: string;
  let settingsPath: string;
  let originalSettingsEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-bearer-keys-'));
    settingsPath = path.join(tmpDir, 'mcp_settings.json');

    originalSettingsEnv = process.env.MCPHUB_SETTING_PATH;
    process.env.MCPHUB_SETTING_PATH = settingsPath;
  });

  afterEach(() => {
    if (originalSettingsEnv === undefined) {
      delete process.env.MCPHUB_SETTING_PATH;
    } else {
      process.env.MCPHUB_SETTING_PATH = originalSettingsEnv;
    }

    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('does not rewrite settings when bearerKeys exists as an empty array', async () => {
    writeSettings(settingsPath, {
      mcpServers: {},
      users: [],
      systemConfig: {
        routing: {
          enableBearerAuth: false,
          bearerAuthKey: '',
        },
      },
      bearerKeys: [],
    });

    const writeSpy = jest.spyOn(fs, 'writeFileSync');

    const dao = new BearerKeyDaoImpl();
    const enabled1 = await dao.findEnabled();
    const enabled2 = await dao.findEnabled();

    expect(enabled1).toEqual([]);
    expect(enabled2).toEqual([]);

    // The DAO should NOT persist anything because bearerKeys already exists.
    expect(writeSpy).not.toHaveBeenCalled();

    writeSpy.mockRestore();
  });

  it('migrates legacy bearerAuthKey only once', async () => {
    writeSettings(settingsPath, {
      mcpServers: {},
      users: [],
      systemConfig: {
        routing: {
          enableBearerAuth: true,
          bearerAuthKey: 'legacy-token',
        },
      },
      // bearerKeys is intentionally missing to trigger migration
    });

    const writeSpy = jest.spyOn(fs, 'writeFileSync');

    const dao = new BearerKeyDaoImpl();

    const enabled1 = await dao.findEnabled();
    expect(enabled1).toHaveLength(1);
    expect(enabled1[0].token).toBeUndefined();
    expect(enabled1[0].tokenHash).toBe(hashBearerToken('legacy-token'));
    expect(enabled1[0].enabled).toBe(true);

    const enabled2 = await dao.findEnabled();
    expect(enabled2).toHaveLength(1);
    expect(enabled2[0].tokenHash).toBe(hashBearerToken('legacy-token'));
    expect((await dao.findByToken('legacy-token'))?.id).toBe(enabled1[0].id);

    // Reads never write; the startup migration is the single write.
    expect(writeSpy).not.toHaveBeenCalled();
    await dao.migrateLegacyTokens();
    await dao.migrateLegacyTokens();
    expect(writeSpy).toHaveBeenCalledTimes(1);

    writeSpy.mockRestore();

    // Neither the legacy key nor its plaintext is left in the settings file.
    const onDisk = fs.readFileSync(settingsPath, 'utf8');
    expect(onDisk).not.toContain('legacy-token');
    expect(JSON.parse(onDisk).systemConfig.routing.bearerAuthKey).toBe('');
  });

  describe('hashing at rest', () => {
    const settingsWith = (bearerKeys: unknown[], bearerAuthKey = '') => ({
      mcpServers: {},
      users: [],
      systemConfig: { routing: { enableBearerAuth: true, bearerAuthKey } },
      bearerKeys,
    });
    const legacyKey = (id: string, token: string) => ({
      id,
      name: id,
      token,
      enabled: true,
      kind: 'system',
      accessType: 'all',
    });

    it('stores only the hash and prefix on create, and returns the plaintext once', async () => {
      writeSettings(settingsPath, settingsWith([]));
      const dao = new BearerKeyDaoImpl();
      const token = generateBearerToken();

      const created = await dao.create({
        name: 'one',
        token,
        enabled: true,
        kind: 'system',
        accessType: 'all',
      });

      expect(created.token).toBe(token);
      const raw = fs.readFileSync(settingsPath, 'utf8');
      expect(raw).not.toContain(token);
      const stored = JSON.parse(raw).bearerKeys[0];
      expect(stored.token).toBeUndefined();
      expect(stored.tokenHash).toBe(hashBearerToken(token));
      expect(stored.tokenPrefix).toBe(token.slice(0, 8));

      // Reads never return the plaintext, and the token still authenticates by hash.
      const listed = await dao.findAll();
      expect(listed[0].token).toBeUndefined();
      expect((await dao.findByToken(token))?.id).toBe(created.id);
      expect(await dao.findByToken(`${token}x`)).toBeUndefined();
    });

    it('hashes plaintext keys left by an older version in place, once', async () => {
      writeSettings(
        settingsPath,
        settingsWith([
          legacyKey('a', 'plain-token-a-0123456789'),
          legacyKey('b', 'plain-token-b-0123456789'),
        ]),
      );
      const dao = new BearerKeyDaoImpl();
      const writeSpy = jest.spyOn(fs, 'writeFileSync');

      expect(await dao.migrateLegacyTokens()).toBe(2);
      expect(await dao.migrateLegacyTokens()).toBe(0);

      expect(writeSpy).toHaveBeenCalledTimes(1);
      writeSpy.mockRestore();
      const raw = fs.readFileSync(settingsPath, 'utf8');
      expect(raw).not.toContain('plain-token');
      // Existing clients keep working: their token hashes to what is stored.
      expect((await dao.findByToken('plain-token-a-0123456789'))?.id).toBe('a');
      expect((await dao.findByToken('plain-token-b-0123456789'))?.id).toBe('b');
    });

    it('clears a legacy routing key that an older migration left behind', async () => {
      writeSettings(settingsPath, settingsWith([], 'stale-legacy-key'));
      const dao = new BearerKeyDaoImpl();

      expect(await dao.findAll()).toEqual([]);
      expect(fs.readFileSync(settingsPath, 'utf8')).toContain('stale-legacy-key');

      await dao.migrateLegacyTokens();
      expect(fs.readFileSync(settingsPath, 'utf8')).not.toContain('stale-legacy-key');
    });

    it('authenticates plaintext keys from memory on read without writing the file', async () => {
      writeSettings(settingsPath, settingsWith([legacyKey('a', 'plain-token-a-0123456789')]));
      const before = fs.readFileSync(settingsPath, 'utf8');
      const writeSpy = jest.spyOn(fs, 'writeFileSync');
      const dao = new BearerKeyDaoImpl();

      expect((await dao.findByToken('plain-token-a-0123456789'))?.id).toBe('a');
      expect((await dao.findAll())[0].token).toBeUndefined();

      expect(writeSpy).not.toHaveBeenCalled();
      writeSpy.mockRestore();
      expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
    });

    it('never derives a key id from the token: constant before persisting, random uuid after', async () => {
      writeSettings(settingsPath, {
        mcpServers: {},
        users: [],
        systemConfig: {
          routing: { enableBearerAuth: true, bearerAuthKey: 'legacy-token-xyz-123' },
        },
      });
      const dao = new BearerKeyDaoImpl();
      const hash = hashBearerToken('legacy-token-xyz-123');

      expect((await dao.findAll())[0].id).toBe('legacy-default');
      expect((await dao.findAll())[0].id).toBe('legacy-default');

      await dao.migrateLegacyTokens();
      const persisted = (await dao.findAll())[0].id;

      expect(persisted).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(persisted).not.toContain(hash.slice(0, 8));
      expect(fs.readFileSync(settingsPath, 'utf8')).not.toContain(hash.slice(0, 16).concat('x'));
      expect((await dao.findAll())[0].id).toBe(persisted);
    });

    it('logs a warning and never throws when the startup write fails', async () => {
      writeSettings(settingsPath, settingsWith([legacyKey('a', 'plain-token-a-0123456789')]));
      const dao = new BearerKeyDaoImpl();
      const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {
        throw new Error('EROFS: read-only file system');
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(dao.migrateLegacyTokens()).resolves.toBe(0);

      writeSpy.mockRestore();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
      error.mockRestore();
      // Requests still authenticate.
      expect((await dao.findByToken('plain-token-a-0123456789'))?.id).toBe('a');
    });

    it('keeps key ids, updates and revocation working on hashed keys', async () => {
      writeSettings(settingsPath, settingsWith([legacyKey('k1', 'plain-token-k1-0123456789')]));
      const dao = new BearerKeyDaoImpl();
      await dao.migrateLegacyTokens();

      expect(await dao.update('k1', { enabled: false })).toMatchObject({
        id: 'k1',
        enabled: false,
      });
      expect(await dao.findEnabled()).toEqual([]);
      expect((await dao.findByToken('plain-token-k1-0123456789'))?.id).toBe('k1');

      expect(await dao.delete('k1')).toBe(true);
      expect(await dao.findByToken('plain-token-k1-0123456789')).toBeUndefined();
    });
  });
});
