import { normalizeManageUrl } from '../../src/utils/manageUrl.js';
import { normalizeServerConfigForPersistence } from '../../src/utils/serverConfigPersistence.js';
import { ServerConfigValidationError } from '../../src/utils/serverConfigValidation.js';

describe('normalizeManageUrl', () => {
  it.each([
    'https://mcp.kazuhahub.com/ubc/',
    'https://canvas.mcp.kazuhahub.com/account/token',
    'https://example.com:8443/a?b=c#d',
    'http://localhost:3000/account',
    'http://127.0.0.1/account',
    'http://[::1]:8080/account',
  ])('accepts %s', (url) => {
    expect(normalizeManageUrl(url)).toBe(url);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeManageUrl('  https://example.com/account \n')).toBe(
      'https://example.com/account',
    );
  });

  it.each([undefined, null, '', '   ', '\n\t'])('treats %j as unset', (value) => {
    expect(normalizeManageUrl(value)).toBeUndefined();
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['http://example.com/account'],
    ['ftp://example.com/file'],
    ['//example.com/account'],
    ['/account/token'],
    ['example.com/account'],
    ['https://user:pass@example.com/account'],
    ['https://user@example.com/account'],
    ['https://example.com/' + 'a'.repeat(2048)],
    [42],
  ])('rejects %j', (value) => {
    expect(() => normalizeManageUrl(value)).toThrow(ServerConfigValidationError);
  });
});

describe('normalizeServerConfigForPersistence manageUrl', () => {
  const base = { type: 'streamable-http' as const, url: 'https://example.com/mcp' };

  it('trims a valid value', () => {
    expect(
      normalizeServerConfigForPersistence({ ...base, manageUrl: ' https://example.com/token ' })
        .manageUrl,
    ).toBe('https://example.com/token');
  });

  it('keeps an explicit key with an undefined value when the field is blank, so it clears', () => {
    const normalized = normalizeServerConfigForPersistence({ ...base, manageUrl: '   ' });
    expect(normalized).toHaveProperty('manageUrl', undefined);
  });

  it('leaves the field out when the request does not carry it', () => {
    expect(normalizeServerConfigForPersistence(base)).not.toHaveProperty('manageUrl');
  });

  it('rejects an unsafe value', () => {
    expect(() =>
      normalizeServerConfigForPersistence({ ...base, manageUrl: 'javascript:alert(1)' }),
    ).toThrow('manageUrl must use https');
  });
});
