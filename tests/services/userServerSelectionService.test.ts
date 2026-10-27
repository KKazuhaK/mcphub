import fs from 'fs';
import os from 'os';
import path from 'path';

import { UserServerSelectionDaoImpl } from '../../src/dao/UserServerSelectionDao.js';
import {
  SELECTION_CACHE_TTL_MS,
  clearServerSelectionCache,
  deleteUserServerSelections,
  getSelectedServerNames,
  isWorkspaceEnabled,
  renameServerSelections,
  setServerSelected,
} from '../../src/services/userServerSelectionService.js';
import { setCachedSystemConfig } from '../../src/utils/systemConfigCache.js';

describe('userServerSelectionService', () => {
  let tmpDir: string;
  let originalSettingsEnv: string | undefined;
  let originalUseDb: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-selection-service-'));
    originalSettingsEnv = process.env.MCPHUB_SETTING_PATH;
    originalUseDb = process.env.USE_DB;
    process.env.MCPHUB_SETTING_PATH = path.join(tmpDir, 'mcp_settings.json');
    process.env.USE_DB = 'false';
    clearServerSelectionCache();
  });

  afterEach(() => {
    if (originalSettingsEnv === undefined) delete process.env.MCPHUB_SETTING_PATH;
    else process.env.MCPHUB_SETTING_PATH = originalSettingsEnv;
    if (originalUseDb === undefined) delete process.env.USE_DB;
    else process.env.USE_DB = originalUseDb;
    setCachedSystemConfig(null);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('treats an absent record as not selected', async () => {
    await setServerSelected('alice', 'fetch', true);
    await setServerSelected('alice', 'git', false);

    expect([...(await getSelectedServerNames('alice'))]).toEqual(['fetch']);
    expect((await getSelectedServerNames('bob')).size).toBe(0);
  });

  it('reads storage once per user until a write invalidates the cache', async () => {
    const listByUsername = jest.spyOn(UserServerSelectionDaoImpl.prototype, 'listByUsername');
    await setServerSelected('alice', 'fetch', true);
    listByUsername.mockClear();

    await getSelectedServerNames('alice');
    await getSelectedServerNames('alice');
    expect(listByUsername).toHaveBeenCalledTimes(1);

    await setServerSelected('alice', 'git', true);
    expect([...(await getSelectedServerNames('alice'))].sort()).toEqual(['fetch', 'git']);
    expect(listByUsername).toHaveBeenCalledTimes(2);
    listByUsername.mockRestore();
  });

  it('expires cached selections after a short TTL so other instances are picked up', async () => {
    await setServerSelected('alice', 'fetch', true);
    const listByUsername = jest.spyOn(UserServerSelectionDaoImpl.prototype, 'listByUsername');
    const now = jest.spyOn(Date, 'now');
    const start = 1_000_000;
    now.mockReturnValue(start);

    await getSelectedServerNames('alice');
    // Another instance changes storage behind this process's back.
    await new UserServerSelectionDaoImpl().save({
      username: 'alice',
      serverName: 'git',
      selected: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    now.mockReturnValue(start + SELECTION_CACHE_TTL_MS - 1);
    expect([...(await getSelectedServerNames('alice'))]).toEqual(['fetch']);
    expect(SELECTION_CACHE_TTL_MS).toBe(5000);

    now.mockReturnValue(start + SELECTION_CACHE_TTL_MS);
    expect([...(await getSelectedServerNames('alice'))].sort()).toEqual(['fetch', 'git']);
    expect(listByUsername).toHaveBeenCalledTimes(2);
    now.mockRestore();
    listByUsername.mockRestore();
  });

  it('does not cache a read that started before a write', async () => {
    await setServerSelected('alice', 'fetch', true);
    clearServerSelectionCache();
    const real = UserServerSelectionDaoImpl.prototype.listByUsername;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const listByUsername = jest
      .spyOn(UserServerSelectionDaoImpl.prototype, 'listByUsername')
      .mockImplementationOnce(async function (this: UserServerSelectionDaoImpl, username) {
        const stale = await real.call(this, username);
        await gate;
        return stale;
      });

    const staleRead = getSelectedServerNames('alice');
    await setServerSelected('alice', 'git', true);
    release();
    // The in-flight read still sees the old rows, but it must not be remembered.
    expect([...(await staleRead)]).toEqual(['fetch']);

    expect([...(await getSelectedServerNames('alice'))].sort()).toEqual(['fetch', 'git']);
    expect(listByUsername).toHaveBeenCalledTimes(2);
    listByUsername.mockRestore();
  });

  it('leaves storage and the cache untouched when a cascade matches nothing', async () => {
    const file = path.join(tmpDir, 'mcp_settings.json.selections.json');
    await deleteUserServerSelections({ serverName: 'fetch' });
    await deleteUserServerSelections({ username: 'alice' });
    await renameServerSelections('old', 'new');
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readdirSync(tmpDir)).toEqual([]);

    await setServerSelected('alice', 'fetch', true);
    await getSelectedServerNames('alice');
    const listByUsername = jest.spyOn(UserServerSelectionDaoImpl.prototype, 'listByUsername');
    const content = fs.readFileSync(file, 'utf8');
    await deleteUserServerSelections({ serverName: 'other' });
    await renameServerSelections('old', 'new');
    await getSelectedServerNames('alice');
    expect(fs.readFileSync(file, 'utf8')).toBe(content);
    expect(listByUsername).not.toHaveBeenCalled();
    listByUsername.mockRestore();
  });

  it('removes the selections of a deleted server for every user', async () => {
    await setServerSelected('alice', 'fetch', true);
    await setServerSelected('bob', 'fetch', true);
    await setServerSelected('bob', 'git', true);
    await getSelectedServerNames('alice');
    await getSelectedServerNames('bob');

    await deleteUserServerSelections({ serverName: 'fetch' });

    expect((await getSelectedServerNames('alice')).size).toBe(0);
    expect([...(await getSelectedServerNames('bob'))]).toEqual(['git']);
  });

  it('removes the selections of a deleted user only', async () => {
    await setServerSelected('alice', 'fetch', true);
    await setServerSelected('bob', 'fetch', true);

    await deleteUserServerSelections({ username: 'alice' });

    expect((await getSelectedServerNames('alice')).size).toBe(0);
    expect([...(await getSelectedServerNames('bob'))]).toEqual(['fetch']);
  });

  it('moves selections to a renamed server', async () => {
    await setServerSelected('alice', 'old', true);
    await getSelectedServerNames('alice');

    await renameServerSelections('old', 'new');

    expect([...(await getSelectedServerNames('alice'))]).toEqual(['new']);
  });

  it('does not fail the surrounding operation when cleanup cannot reach storage', async () => {
    const remove = jest
      .spyOn(UserServerSelectionDaoImpl.prototype, 'delete')
      .mockRejectedValue(new Error('disk full'));

    await expect(deleteUserServerSelections({ serverName: 'fetch' })).resolves.toBeUndefined();
    remove.mockRestore();
  });

  it('is enabled only by systemConfig.workspace.enabled', () => {
    setCachedSystemConfig({});
    expect(isWorkspaceEnabled()).toBe(false);
    setCachedSystemConfig({ workspace: { enabled: false } });
    expect(isWorkspaceEnabled()).toBe(false);
    setCachedSystemConfig({ workspace: { enabled: true } });
    expect(isWorkspaceEnabled()).toBe(true);
  });
});
