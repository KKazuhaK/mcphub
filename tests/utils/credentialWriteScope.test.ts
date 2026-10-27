import fs from 'node:fs';
import path from 'node:path';
import {
  credentialWriteServerName,
  includesCredentialWriteScope,
  normalizeCredentialWriteClients,
  soleCredentialWriteServer,
} from '../../src/utils/credentialWriteScope.js';
import { ServerConfigValidationError } from '../../src/utils/serverConfigValidation.js';
import { normalizeServerConfigForPersistence } from '../../src/utils/serverConfigPersistence.js';

describe('credential-write scope helpers', () => {
  it('parses the server name only from a well-formed scope', () => {
    expect(credentialWriteServerName('credentials:write:ubc-personal')).toBe('ubc-personal');
    expect(credentialWriteServerName('credentials:write:')).toBeNull();
    expect(credentialWriteServerName('credentials:read:x')).toBeNull();
    expect(credentialWriteServerName('read')).toBeNull();
  });

  it('narrows to one server only when the scope stands alone', () => {
    expect(soleCredentialWriteServer('credentials:write:a')).toBe('a');
    expect(soleCredentialWriteServer(['credentials:write:a'])).toBe('a');
    expect(soleCredentialWriteServer('credentials:write:a read')).toBeNull();
    expect(soleCredentialWriteServer('credentials:write:a credentials:write:b')).toBeNull();
    expect(soleCredentialWriteServer('read')).toBeNull();
    expect(soleCredentialWriteServer(undefined)).toBeNull();
    expect(includesCredentialWriteScope('read credentials:write:a')).toBe(true);
    expect(includesCredentialWriteScope('read write')).toBe(false);
  });
});

describe('normalizeCredentialWriteClients', () => {
  it('trims, de-duplicates and treats null, undefined and empty as none', () => {
    expect(normalizeCredentialWriteClients([' a ', 'a', 'b', ''])).toEqual(['a', 'b']);
    expect(normalizeCredentialWriteClients(undefined)).toBeUndefined();
    expect(normalizeCredentialWriteClients(null)).toBeUndefined();
    expect(normalizeCredentialWriteClients([])).toBeUndefined();
  });

  it('rejects malformed values', () => {
    expect(() => normalizeCredentialWriteClients('a')).toThrow(ServerConfigValidationError);
    expect(() => normalizeCredentialWriteClients([1])).toThrow(ServerConfigValidationError);
    expect(() =>
      normalizeCredentialWriteClients(Array.from({ length: 51 }, (_, i) => `c${i}`)),
    ).toThrow(ServerConfigValidationError);
  });

  it('is emitted by persistence only when the config carries the key', () => {
    const base = { type: 'sse' as const, url: 'https://example.com/sse' };
    expect(normalizeServerConfigForPersistence(base)).not.toHaveProperty('credentialWriteClients');
    expect(
      normalizeServerConfigForPersistence({ ...base, credentialWriteClients: [' a '] }),
    ).toHaveProperty('credentialWriteClients', ['a']);
    expect(
      normalizeServerConfigForPersistence({ ...base, credentialWriteClients: null as never }),
    ).toHaveProperty('credentialWriteClients', undefined);
  });
});

describe('credential-write consent text', () => {
  it.each(['en', 'es', 'fr', 'tr', 'vi', 'zh'])('is localized for %s', (locale) => {
    const messages = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../../locales', `${locale}.json`), 'utf8'),
    );
    const text: string = messages.oauthServer.credentialWrite;
    expect(text).toContain('{{client}}');
    expect(text).toContain('{{server}}');
  });
});
