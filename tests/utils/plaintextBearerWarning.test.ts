import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let dbMode = true;
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  isDatabaseModeEnabled: () => dbMode,
}));

import { warnAboutPlaintextBearerKeysInSettingsFile } from '../../src/utils/plaintextBearerWarning.js';

describe('plaintext bearer keys left in the settings file (database mode)', () => {
  let directory: string;
  let file: string;
  const original = process.env.MCPHUB_SETTING_PATH;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-warn-'));
    file = path.join(directory, 'mcp_settings.json');
    process.env.MCPHUB_SETTING_PATH = file;
    dbMode = true;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    if (original === undefined) delete process.env.MCPHUB_SETTING_PATH;
    else process.env.MCPHUB_SETTING_PATH = original;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const write = (settings: unknown) => fs.writeFileSync(file, JSON.stringify(settings));

  it('warns, without naming any value, and leaves the file untouched', () => {
    write({
      mcpServers: {},
      bearerKeys: [{ id: 'a', token: 'plaintext-token-AAA' }],
      systemConfig: { routing: { bearerAuthKey: 'legacy-plaintext-BBB' } },
    });
    const before = fs.readFileSync(file, 'utf8');

    expect(warnAboutPlaintextBearerKeysInSettingsFile()).toBe(2);

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('plaintext bearer key');
    expect(logged).not.toMatch(/plaintext-token-AAA|legacy-plaintext-BBB/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('stays quiet when the file holds no plaintext', () => {
    write({ mcpServers: {}, bearerKeys: [{ id: 'a', tokenHash: 'h' }], systemConfig: {} });
    expect(warnAboutPlaintextBearerKeysInSettingsFile()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing outside database mode', () => {
    dbMode = false;
    write({ mcpServers: {}, bearerKeys: [{ id: 'a', token: 'plaintext-token-AAA' }] });
    expect(warnAboutPlaintextBearerKeysInSettingsFile()).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
