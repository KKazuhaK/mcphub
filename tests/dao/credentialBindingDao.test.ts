import fs from 'fs';
import os from 'os';
import path from 'path';

import { CredentialBindingDaoImpl } from '../../src/dao/CredentialBindingDao.js';

const binding = (serverName: string, username: string) => ({
  serverName,
  username,
  encryptedValues: `ciphertext-${username}`,
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('CredentialBindingDaoImpl.listUsernames', () => {
  let tmpDir: string;
  let settingsPath: string;
  let originalSettingsEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-credential-bindings-'));
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

  const writeBindings = (bindings: unknown): void => {
    fs.writeFileSync(`${settingsPath}.credentials.json`, JSON.stringify(bindings), 'utf8');
  };

  it('returns only the usernames bound to the requested server', async () => {
    writeBindings([
      binding('private-api', 'alice'),
      binding('private-api', 'bob'),
      binding('other-server', 'carol'),
    ]);

    await expect(new CredentialBindingDaoImpl().listUsernames('private-api')).resolves.toEqual([
      'alice',
      'bob',
    ]);
  });

  it('returns an empty list when the binding store does not exist', async () => {
    await expect(new CredentialBindingDaoImpl().listUsernames('private-api')).resolves.toEqual([]);
  });

  it('returns an empty list when no user bound the server', async () => {
    writeBindings([binding('other-server', 'carol')]);
    await expect(new CredentialBindingDaoImpl().listUsernames('private-api')).resolves.toEqual([]);
  });
});

describe('CredentialBindingDaoImpl.adoptDestinationFingerprint', () => {
  let tmpDir: string;
  let original: string | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-credential-adopt-'));
    original = process.env.MCPHUB_SETTING_PATH;
    process.env.MCPHUB_SETTING_PATH = path.join(tmpDir, 'mcp_settings.json');
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MCPHUB_SETTING_PATH;
    else process.env.MCPHUB_SETTING_PATH = original;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stamps only an unbound row that still holds the expected ciphertext', async () => {
    const dao = new CredentialBindingDaoImpl();
    await dao.save(binding('s', 'alice'));
    await dao.save(binding('s', 'bob'));
    expect(await dao.adoptDestinationFingerprint('s', 'alice', 'stale-ciphertext', 'v1:a')).toBe(
      false,
    );
    expect(await dao.adoptDestinationFingerprint('s', 'alice', 'ciphertext-alice', 'v1:a')).toBe(
      true,
    );
    expect(await dao.adoptDestinationFingerprint('s', 'alice', 'ciphertext-alice', 'v1:b')).toBe(
      false,
    );
    expect(await dao.adoptDestinationFingerprint('s', 'nobody', 'x', 'v1:a')).toBe(false);
    expect((await dao.get('s', 'alice'))?.destinationFingerprint).toBe('v1:a');
    expect((await dao.get('s', 'bob'))?.destinationFingerprint).toBeUndefined();
  });
});

describe('CredentialBindingDaoImpl stamping support', () => {
  let tmpDir: string;
  let original: string | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-credential-stamp-'));
    original = process.env.MCPHUB_SETTING_PATH;
    process.env.MCPHUB_SETTING_PATH = path.join(tmpDir, 'mcp_settings.json');
  });
  afterEach(() => {
    if (original === undefined) delete process.env.MCPHUB_SETTING_PATH;
    else process.env.MCPHUB_SETTING_PATH = original;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists only unstamped bindings and sets a server fingerprint on all of its rows', async () => {
    const dao = new CredentialBindingDaoImpl();
    await dao.save({ ...binding('s', 'alice'), destinationFingerprint: 'v1:a' });
    await dao.save(binding('s', 'bob'));
    await dao.save(binding('other', 'carol'));
    expect((await dao.listUnstamped()).map((row) => row.username).sort()).toEqual(['bob', 'carol']);
    await dao.setServerFingerprint('s', 'v1:orphaned');
    expect((await dao.get('s', 'alice'))?.destinationFingerprint).toBe('v1:orphaned');
    expect((await dao.get('s', 'bob'))?.destinationFingerprint).toBe('v1:orphaned');
    expect((await dao.get('other', 'carol'))?.destinationFingerprint).toBeUndefined();
  });
});
