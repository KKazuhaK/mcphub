import fs from 'fs';
import os from 'os';
import path from 'path';

import { UserServerSelectionDaoImpl } from '../../src/dao/UserServerSelectionDao.js';

const selection = (username: string, serverName: string, selected = true) => ({
  username,
  serverName,
  selected,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('UserServerSelectionDaoImpl', () => {
  let tmpDir: string;
  let settingsPath: string;
  let originalSettingsEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-user-selections-'));
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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns nothing when the store does not exist', async () => {
    await expect(new UserServerSelectionDaoImpl().listByUsername('alice')).resolves.toEqual([]);
  });

  it('round-trips selections through a sidecar file next to the settings file', async () => {
    const dao = new UserServerSelectionDaoImpl();
    await dao.save(selection('alice', 'fetch'));
    await dao.save(selection('alice', 'git', false));
    await dao.save(selection('bob', 'fetch'));

    const stored = JSON.parse(fs.readFileSync(`${settingsPath}.selections.json`, 'utf8'));
    expect(stored).toHaveLength(3);
    expect(fs.existsSync(settingsPath)).toBe(false);
    expect(fs.readdirSync(tmpDir).filter((file) => file.endsWith('.tmp'))).toEqual([]);

    await expect(new UserServerSelectionDaoImpl().listByUsername('alice')).resolves.toEqual([
      selection('alice', 'fetch'),
      selection('alice', 'git', false),
    ]);
  });

  it('keeps one record per user and server', async () => {
    const dao = new UserServerSelectionDaoImpl();
    await dao.save(selection('alice', 'fetch'));
    await dao.save(selection('alice', 'fetch', false));

    await expect(dao.listByUsername('alice')).resolves.toEqual([
      selection('alice', 'fetch', false),
    ]);
  });

  it('deletes by server, by user, or by both', async () => {
    const dao = new UserServerSelectionDaoImpl();
    const seed = async () => {
      fs.rmSync(`${settingsPath}.selections.json`, { force: true });
      for (const [username, serverName] of [
        ['alice', 'fetch'],
        ['alice', 'git'],
        ['bob', 'fetch'],
      ]) {
        await dao.save(selection(username, serverName));
      }
    };
    const remaining = () =>
      dao
        .readAll()
        .map((row) => `${row.username}:${row.serverName}`)
        .sort();

    await seed();
    await dao.delete({ serverName: 'fetch' });
    expect(remaining()).toEqual(['alice:git']);

    await seed();
    await dao.delete({ username: 'alice' });
    expect(remaining()).toEqual(['bob:fetch']);

    await seed();
    await dao.delete({ username: 'alice', serverName: 'fetch' });
    expect(remaining()).toEqual(['alice:git', 'bob:fetch']);

    await seed();
    await dao.delete({});
    expect(remaining()).toHaveLength(3);
  });

  it('leaves storage untouched when a delete or rename matches nothing', async () => {
    const dao = new UserServerSelectionDaoImpl();
    const file = `${settingsPath}.selections.json`;

    await expect(dao.delete({ serverName: 'fetch' })).resolves.toBe(false);
    await expect(dao.delete({ username: 'alice' })).resolves.toBe(false);
    await expect(dao.renameServer('old', 'new')).resolves.toBe(false);
    expect(fs.existsSync(file)).toBe(false);

    await dao.save(selection('alice', 'fetch'));
    const before = fs.statSync(file).mtimeMs;
    const content = fs.readFileSync(file, 'utf8');
    await expect(dao.delete({ serverName: 'other' })).resolves.toBe(false);
    await expect(dao.renameServer('old', 'new')).resolves.toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });

  it('moves every user’s selection to a renamed server and drops stale rows of the new name', async () => {
    const dao = new UserServerSelectionDaoImpl();
    await dao.save(selection('alice', 'old'));
    await dao.save(selection('bob', 'old', false));
    await dao.save(selection('alice', 'other'));
    await dao.save(selection('carol', 'new'));

    await dao.renameServer('old', 'new');

    expect(
      dao
        .readAll()
        .map((row) => `${row.username}:${row.serverName}:${row.selected}`)
        .sort(),
    ).toEqual(['alice:new:true', 'alice:other:true', 'bob:new:false']);
  });

  describe('risk ceiling', () => {
    it('stores a ceiling without selecting, and a later selection keeps it', async () => {
      const dao = new UserServerSelectionDaoImpl();
      await dao.saveRiskCeiling('alice', 'fetch', 'write', '2026-01-02T00:00:00.000Z');

      expect(dao.readAll()).toEqual([
        {
          username: 'alice',
          serverName: 'fetch',
          selected: false,
          riskCeiling: 'write',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);

      await dao.save(selection('alice', 'fetch'));
      expect(await dao.listByUsername('alice')).toEqual([
        { ...selection('alice', 'fetch'), riskCeiling: 'write' },
      ]);
    });

    it('keeps an existing selection when only the ceiling changes', async () => {
      const dao = new UserServerSelectionDaoImpl();
      await dao.save(selection('alice', 'fetch', true));
      await dao.saveRiskCeiling('alice', 'fetch', 'external', '2026-01-02T00:00:00.000Z');

      expect(dao.readAll()).toEqual([
        {
          ...selection('alice', 'fetch', true),
          riskCeiling: 'external',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      ]);
    });

    it('replaces a stored ceiling only when a new one is given, and stays per user and server', async () => {
      const dao = new UserServerSelectionDaoImpl();
      await dao.saveRiskCeiling('alice', 'fetch', 'write', '2026-01-02T00:00:00.000Z');
      await dao.saveRiskCeiling('bob', 'fetch', 'external', '2026-01-02T00:00:00.000Z');
      await dao.save({ ...selection('alice', 'fetch'), riskCeiling: 'read' });

      expect(
        dao
          .readAll()
          .map((row) => `${row.username}:${row.serverName}:${row.riskCeiling}`)
          .sort(),
      ).toEqual(['alice:fetch:read', 'bob:fetch:external']);
    });

    it('follows a renamed server and is removed with the server or the user', async () => {
      const dao = new UserServerSelectionDaoImpl();
      await dao.saveRiskCeiling('alice', 'old', 'write', '2026-01-02T00:00:00.000Z');
      await dao.renameServer('old', 'new');
      expect(dao.readAll().map((row) => [row.serverName, row.riskCeiling])).toEqual([
        ['new', 'write'],
      ]);

      await dao.delete({ username: 'alice' });
      expect(dao.readAll()).toEqual([]);
    });
  });
});
