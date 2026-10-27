import {
  redactArgs,
  redactEnv,
  redactHeaders,
  redactRequestUrl,
  redactSecrets,
  redactUrl,
  truncateBody,
} from '../../src/utils/redaction.js';
import { logger, redact } from '../../src/utils/logger.js';
import { collectConfigSecrets } from '../../src/utils/upstreamError.js';
import { getStdioStderrTail, observeStdioStderr } from '../../src/utils/stdioDiagnostics.js';

describe('redactUrl', () => {
  it('removes userinfo, every query value and the fragment', () => {
    expect(redactUrl('https://user:pass@host.example/path?token=abc&lang=en#frag')).toBe(
      'https://[REDACTED]@host.example/path?token=[REDACTED]&lang=[REDACTED]',
    );
  });

  it('handles request targets that are not absolute URLs', () => {
    expect(redactRequestUrl('/mcp/group?token=abc&access_token=def&key=ghi')).toBe(
      '/mcp/group?token=[REDACTED]&access_token=[REDACTED]&key=[REDACTED]',
    );
    expect(redactRequestUrl(undefined)).toBe('');
  });

  it('also replaces known secrets that sit in the path or host', () => {
    expect(
      redactUrl('https://tenant-9f3a77.example.com/v1/seg-9f3a77/mcp', [
        'tenant-9f3a77',
        'seg-9f3a77',
      ]),
    ).toBe('https://[REDACTED].example.com/v1/[REDACTED]/mcp');
  });
});

describe('redactHeaders / redactEnv / redactArgs / truncateBody', () => {
  it('redacts credential headers and any header carrying a known secret', () => {
    expect(
      redactHeaders(
        {
          Authorization: 'Bearer abc',
          Cookie: 'sid=1',
          'X-Api-Key': 'k',
          'X-Auth-Token': 't',
          'X-Tenant': 'slot-value-1234',
          Accept: 'application/json',
        },
        ['slot-value-1234'],
      ),
    ).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      'X-Auth-Token': '[REDACTED]',
      'X-Tenant': '[REDACTED]',
      Accept: 'application/json',
    });
  });

  it('never keeps an env value', () => {
    expect(redactEnv({ PERSONAL_KEY: 'v1', PATH: '/bin' })).toEqual({
      PERSONAL_KEY: '[REDACTED]',
      PATH: '[REDACTED]',
    });
  });

  it('redacts credential flags and known secrets in arguments', () => {
    expect(
      redactArgs(
        [
          '--token=abc',
          '--api-key',
          'def',
          '--verbose',
          'arg-with-slot-value-1234',
          'https://h/p?x=1',
        ],
        ['slot-value-1234'],
      ),
    ).toEqual([
      '--token=[REDACTED]',
      '--api-key',
      '[REDACTED]',
      '--verbose',
      'arg-with-[REDACTED]',
      'https://h/p?x=[REDACTED]',
    ]);
  });

  it('truncates long bodies after removing secrets', () => {
    const body = `secret-body-value-1234 ${'x'.repeat(2000)}`;
    const out = truncateBody(body, 100, ['secret-body-value-1234']);
    expect(out).not.toContain('secret-body-value-1234');
    expect(out.startsWith('[REDACTED] x')).toBe(true);
    expect(out).toContain('truncated');
    expect(out.length).toBeLessThan(200);
  });

  it('matches secrets in their JSON-escaped and URL-encoded forms', () => {
    const secret = 'a b"c&d-secret';
    expect(redactSecrets(`x ${encodeURIComponent(secret)} y`, [secret])).toBe('x [REDACTED] y');
    expect(redactSecrets(`{"k":"${JSON.stringify(secret).slice(1, -1)}"}`, [secret])).toBe(
      '{"k":"[REDACTED]"}',
    );
  });
});

describe('logger redaction', () => {
  it('redacts structured url, headers, env and args values', () => {
    const out = redact({
      serverUrl: 'https://u:p@h.example/mcp?api=zzz',
      url: 'https://h.example/x?token=t',
      headers: { 'X-Custom-Token': 'v', Accept: 'a/b' },
      env: { ANYTHING: 'plain' },
      args: ['--password', 'pw', 'ok'],
    });
    expect(JSON.stringify(out)).not.toMatch(/zzz|u:p|token=t|"v"|plain|"pw"/);
    expect(out.headers).toMatchObject({ Accept: 'a/b' });
    expect(out.args).toEqual(['--password', '[REDACTED]', 'ok']);
  });

  it('redacts URL credentials in free text', () => {
    const out = redact(
      'GET /mcp?token=mcphub_ABCDEF123456&sessionId=s1 via https://u:p@h/x?key=k1',
    );
    expect(out).not.toMatch(/ABCDEF123456|u:p|key=k1/);
  });

  it('logs a sanitized copy of an error carrying a request config', () => {
    const error = Object.assign(
      new Error('failed GET https://h.example/api?access_token=abc123456'),
      {
        config: {
          headers: { Authorization: 'Bearer abc123456', Accept: 'a/b' },
          url: 'https://h/x?k=v',
        },
      },
    );
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.error('boom', error);
    const printed = JSON.stringify(
      spy.mock.calls.map(([, logged]) => ({
        message: (logged as Error).message,
        stack: (logged as Error).stack,
        config: (logged as any).config,
      })),
    );
    spy.mockRestore();
    expect(printed).not.toMatch(/abc123456|k=v/);
    expect(printed).toContain('Accept');
  });

  it('forwards an error with nothing to redact as the same object', () => {
    const error = new Error('plain failure');
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.error('boom', error);
    const logged = spy.mock.calls[0][1];
    spy.mockRestore();
    expect(logged).toBe(error);
  });
});

describe('stdio stderr of a configured server', () => {
  it('drops env credential values the child echoes, in log lines and the attached tail', () => {
    const secrets = collectConfigSecrets({
      type: 'stdio',
      command: 'x',
      env: { API_TOKEN: 'env-token-value-9921', PLAIN: 'visible-value' },
    });
    const handlers: Record<string, (data?: Buffer) => void> = {};
    const stream = { on: (event: string, cb: (data?: Buffer) => void) => (handlers[event] = cb) };
    const lines: string[] = [];
    const transport = {};

    observeStdioStderr(transport, stream as never, (line) => lines.push(line), secrets);
    handlers.data(Buffer.from('connecting with env-token-value-9921 and visible-value\n'));

    expect(lines.join('\n')).not.toContain('env-token-value-9921');
    expect(lines.join('\n')).toContain('visible-value');
    expect(getStdioStderrTail(transport)).not.toContain('env-token-value-9921');
  });
});

describe('logger redactError safety', () => {
  const capture = (error: unknown) => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    logger.error('boom', error);
    const logged = spy.mock.calls[0][1];
    spy.mockRestore();
    return logged as Error;
  };

  it('survives a cyclic cause chain and leaves the original untouched', () => {
    const a = new Error('a failed at https://h/x?token=secretvalue1');
    const b = new Error('b failed');
    (a as any).cause = b;
    (b as any).cause = a;

    const logged = capture(a);

    expect(logged).not.toBe(a);
    expect(logged.message).not.toContain('secretvalue1');
    expect(a.message).toContain('secretvalue1');
    expect((a as any).cause).toBe(b);
    expect(JSON.stringify((logged as any).cause)).toBeDefined();
    expect(String((logged as any).cause.cause?.message ?? (logged as any).cause.cause)).toMatch(
      /Circular|Truncated/,
    );
  });

  it('names sockets, requests and buffers instead of walking them', () => {
    class Socket {
      secret = { deep: { deeper: 'x' } };
      constructor(public self?: unknown) {
        this.self = this;
      }
    }
    const error = Object.assign(new Error('fail'), {
      socket: new Socket(),
      body: Buffer.from('abc'),
      status: 502,
    });

    const logged = capture(error) as any;

    expect(logged.socket).toBe('[Socket]');
    expect(logged.body).toBe('[Buffer 3 bytes]');
    expect(logged.status).toBe(502);
    expect(error.socket).toBeInstanceOf(Socket);
  });

  it('caps the number of properties it walks', () => {
    const error = new Error('many');
    for (let i = 0; i < 100; i += 1) (error as any)[`p${i}`] = i;
    const logged = capture(error) as any;
    expect(Object.keys(logged).length).toBeLessThanOrEqual(26);
    expect(logged['[truncated]']).toContain('75 more');
  });
});

describe('collectConfigSecrets', () => {
  const base = { type: 'openapi' as const };

  it('includes OpenAPI security values for the API and the spec download', () => {
    const basic = Buffer.from('apiuser:apipassword').toString('base64');
    const secrets = collectConfigSecrets({
      ...base,
      openapi: {
        security: {
          type: 'apiKey',
          apiKey: { name: 'k', in: 'header', value: 'api-key-value-1' },
        },
        specSecurity: {
          type: 'http',
          http: { scheme: 'basic', credentials: basic },
        },
      },
    } as never);
    expect(secrets).toEqual(expect.arrayContaining(['api-key-value-1', basic, 'apipassword']));

    const oauth = collectConfigSecrets({
      ...base,
      openapi: {
        security: {
          type: 'oauth2',
          oauth2: { token: 'oauth2-token-1', clientSecret: 'oauth2-secret-1' },
        },
        specSecurity: {
          type: 'openIdConnect',
          openIdConnect: { url: 'u', token: 'oidc-token-1', clientSecret: 'oidc-secret-1' },
        },
      },
    } as never);
    expect(oauth).toEqual(
      expect.arrayContaining([
        'oauth2-token-1',
        'oauth2-secret-1',
        'oidc-token-1',
        'oidc-secret-1',
      ]),
    );
  });

  it('scrubs definite credentials from length 4 and ignores shorter ones', () => {
    const secrets = collectConfigSecrets({
      type: 'streamable-http',
      url: 'https://h',
      oauth: { accessToken: 'abcd', refreshToken: 'abc' },
    } as never);
    expect(secrets).toContain('abcd');
    expect(secrets).not.toContain('abc');
  });

  it('does not treat configuration that merely has a credential-like name as secret', () => {
    const secrets = collectConfigSecrets({
      type: 'stdio',
      command: 'x',
      env: {
        TOKEN_ENABLED: 'true',
        SESSION_DIR: '/var/lib/mcphub/sessions',
        API_KEY_COUNT: '12345678',
        SECRET_SHORT: 'abc123',
        API_TOKEN: 'real-token-value-9',
      },
      headers: { 'X-Api-Key': 'header-key-value-9' },
    } as never);
    expect(secrets).toEqual(expect.arrayContaining(['real-token-value-9', 'header-key-value-9']));
    for (const value of ['true', '/var/lib/mcphub/sessions', '12345678', 'abc123']) {
      expect(secrets).not.toContain(value);
    }
    expect(redactSecrets('TOKEN_ENABLED=true SESSION_DIR=/var/lib/mcphub/sessions', secrets)).toBe(
      'TOKEN_ENABLED=true SESSION_DIR=/var/lib/mcphub/sessions',
    );
  });
});
