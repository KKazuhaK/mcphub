import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CredentialBindingDaoImpl } from '../../src/dao/CredentialBindingDao.js';
import {
  canonicalDestination,
  copyCredentialBindings,
  computeDestinationFingerprint,
  encryptCredentialValues,
  getCredentialBindingStatus,
  listValidBindingUsers,
  retireServerBindings,
  stampLegacyBindings,
  resolveCredentialBinding,
  saveCredentialBinding,
} from '../../src/services/credentialBindingService.js';
import { PrincipalRuntimeService } from '../../src/services/principalRuntimeService.js';
import {
  buildUserServerStatus,
  getPersonalAuthState,
  resolveUserServerState,
} from '../../src/services/userServerStatusService.js';
import {
  CredentialBindingError,
  MissingCredentialError,
  StaleCredentialError,
} from '../../src/utils/credentialTemplate.js';
import {
  ORPHANED_FINGERPRINT,
  canonicalCredentialDestination,
} from '../../src/utils/credentialDestination.js';
import { initI18n } from '../../src/utils/i18n.js';
import { setCachedSystemConfig } from '../../src/utils/systemConfigCache.js';
import type { ServerConfig, ServerInfo } from '../../src/types/index.js';

let definition: ServerConfig & { name: string };
const servers = new Map<string, ServerConfig & { name: string }>();
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getCredentialBindingDao: () =>
    new (jest.requireActual('../../src/dao/CredentialBindingDao.js').CredentialBindingDaoImpl)(),
  getServerDao: () => ({
    findById: async (name: string) => servers.get(name) ?? (name === 'shared' ? definition : null),
  }),
  getUserDao: () => ({ findByUsername: async () => ({ username: 'admin', isAdmin: true }) }),
}));

const SENTINEL = 'alice-personal-secret';
const base: ServerConfig = {
  type: 'stdio',
  command: 'node',
  args: ['server.js', '--key={{args.TOKEN}}'],
  env: { PERSONAL_KEY: 'placeholder', HTTPS_PROXY: 'http://proxy-a:3128', REGION: 'eu' },
  owner: 'admin',
  visibility: 'public',
  credentialTemplate: [
    { target: 'env', name: 'PERSONAL_KEY', label: 'Key' },
    { target: 'args', name: 'TOKEN' },
  ],
};
const values = { 'env.PERSONAL_KEY': SENTINEL, 'args.TOKEN': 'tok' };
const remote: ServerConfig = {
  type: 'streamable-http',
  url: 'https://api.example.com:8443/mcp?tenant=a',
  headers: { Authorization: 'org', 'X-Region': 'eu' },
  owner: 'admin',
  visibility: 'public',
  credentialTemplate: [{ target: 'headers', name: 'Authorization' }],
};
const alice = { username: 'alice@example.com' };
let directory: string;
const originalPath = process.env.MCPHUB_SETTING_PATH;
const originalKey = process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
const dao = () => new CredentialBindingDaoImpl();
const fingerprintOf = (config: ServerConfig) => computeDestinationFingerprint(config);
const child = (): ServerInfo => ({
  name: 'shared',
  status: 'connected',
  tools: [],
  prompts: [],
  resources: [],
  error: null,
  createTime: Date.now(),
});

beforeAll(async () => {
  await initI18n();
});
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-destination-'));
  process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  setCachedSystemConfig({});
  definition = { name: 'shared', ...base };
  servers.clear();
});
afterEach(() => {
  setCachedSystemConfig({});
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalPath === undefined) delete process.env.MCPHUB_SETTING_PATH;
  else process.env.MCPHUB_SETTING_PATH = originalPath;
  if (originalKey === undefined) delete process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = originalKey;
});

describe('destination fingerprint', () => {
  const same: Array<[string, Partial<ServerConfig>]> = [
    ['description', { description: 'edited' }],
    ['visibility', { visibility: 'private' }],
    ['sharing', { visibility: 'group', sharedWithUsers: ['bob'] }],
    ['enabled', { enabled: false }],
    ['owner', { owner: 'someone-else' }],
    ['tool settings', { tools: { x: { enabled: false } } }],
    ['prompt settings', { prompts: { x: { enabled: false } } }],
    ['request timeout', { options: { timeout: 1 } }],
    ['keep-alive', { enableKeepAlive: true, keepAliveInterval: 5 }],
    ['on-demand', { startOnDemand: true, idleTimeoutMs: 10 }],
    ['passthrough headers', { passthroughHeaders: ['x-trace'] }],
    ['pause and maintenance', { pausedUsers: ['bob'], maintenance: { message: 'soon' } }],
    ['tool risk', { maxToolRisk: 'read', defaultUserRisk: 'read', toolRiskOverrides: {} }],
    [
      'slot label',
      {
        credentialTemplate: [
          { target: 'env', name: 'PERSONAL_KEY', label: 'New' },
          { target: 'args', name: 'TOKEN' },
        ],
      },
    ],
    [
      'slot order',
      {
        credentialTemplate: [
          { target: 'args', name: 'TOKEN' },
          { target: 'env', name: 'PERSONAL_KEY' },
        ],
      },
    ],
    ['the value of an env variable a slot fills', { env: { ...base.env, PERSONAL_KEY: 'other' } }],
    [
      'env key order',
      { env: { REGION: 'eu', HTTPS_PROXY: 'http://proxy-a:3128', PERSONAL_KEY: 'placeholder' } },
    ],
  ];
  test.each(same)('is unchanged by %s', async (_name, edit) => {
    expect(await fingerprintOf({ ...base, ...edit })).toBe(await fingerprintOf(base));
  });

  const different: Array<[string, Partial<ServerConfig>]> = [
    ['the transport', { type: 'sse', url: 'https://x.example.com' }],
    ['the command', { command: 'deno' }],
    ['an argument', { args: ['server.js', '--key={{args.TOKEN}}', '--extra'] }],
    ['argument order', { args: ['--key={{args.TOKEN}}', 'server.js'] }],
    [
      'an env value that redirects traffic',
      { env: { ...base.env, HTTPS_PROXY: 'http://evil:3128' } },
    ],
    ['an added env variable', { env: { ...base.env, EXTRA: '1' } }],
    [
      'a removed env variable',
      { env: { PERSONAL_KEY: 'placeholder', HTTPS_PROXY: 'http://proxy-a:3128' } },
    ],
    ['a proxy', { proxy: { enabled: true, type: 'socks5', host: 'p', port: 1080 } }],
    [
      'the slot target',
      {
        credentialTemplate: [
          { target: 'env', name: 'PERSONAL_KEY' },
          { target: 'env', name: 'TOKEN' },
        ],
        args: ['server.js'],
      },
    ],
    [
      'the slot name',
      {
        credentialTemplate: [
          { target: 'env', name: 'OTHER_KEY' },
          { target: 'args', name: 'TOKEN' },
        ],
      },
    ],
  ];
  test.each(different)('changes with %s', async (_name, edit) => {
    expect(await fingerprintOf({ ...base, ...edit })).not.toBe(await fingerprintOf(base));
  });

  const remoteDifferent: Array<[string, Partial<ServerConfig>]> = [
    ['the scheme', { url: 'http://api.example.com:8443/mcp?tenant=a' }],
    ['the host', { url: 'https://evil.example.com:8443/mcp?tenant=a' }],
    ['the port', { url: 'https://api.example.com:9443/mcp?tenant=a' }],
    ['the path', { url: 'https://api.example.com:8443/other?tenant=a' }],
    ['the query', { url: 'https://api.example.com:8443/mcp?tenant=b' }],
    ['a header value', { headers: { Authorization: 'org', 'X-Region': 'us' } }],
    ['a header name', { headers: { Authorization: 'org', 'X-Zone': 'eu' } }],
    ['an openapi document', { openapi: { url: 'https://spec.example.com/openapi.json' } }],
  ];
  test.each(remoteDifferent)('changes with %s of an HTTP server', async (_name, edit) => {
    expect(await fingerprintOf({ ...remote, ...edit })).not.toBe(await fingerprintOf(remote));
  });

  test('ignores the header a slot fills in any case, and header order', async () => {
    const reordered = { ...remote, headers: { 'X-Region': 'eu', authorization: 'changed' } };
    expect(await fingerprintOf(reordered)).toBe(await fingerprintOf(remote));
  });

  test('keeps headers as sent: a hidden duplicate that differs only in case changes it', async () => {
    const duplicated = { ...remote, headers: { ...remote.headers, 'x-region': 'us' } };
    expect(await fingerprintOf(duplicated)).not.toBe(await fingerprintOf(remote));
    const renamedCase = { ...remote, headers: { Authorization: 'org', 'x-region': 'eu' } };
    expect(await fingerprintOf(renamedCase)).not.toBe(await fingerprintOf(remote));
  });

  test('is independent of object key order', async () => {
    const shuffled: ServerConfig = {
      credentialTemplate: [...base.credentialTemplate!].reverse(),
      visibility: 'public',
      owner: 'admin',
      env: { REGION: 'eu', PERSONAL_KEY: 'placeholder', HTTPS_PROXY: 'http://proxy-a:3128' },
      args: base.args,
      command: 'node',
      type: 'stdio',
    };
    expect(canonicalCredentialDestination(shuffled)).toBe(canonicalCredentialDestination(base));
  });

  test('is keyed: another key gives another value, and the value reveals nothing', async () => {
    const first = await fingerprintOf(base);
    expect(first).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(first).not.toContain('proxy-a');
    process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    expect(await fingerprintOf(base)).not.toBe(first);
  });
});

describe.each([
  ['Workspace Mode off', undefined],
  ['Workspace Mode on', { workspace: { enabled: true } }],
])('a binding made for another destination (%s)', (_label, systemConfig) => {
  beforeEach(() => setCachedSystemConfig((systemConfig ?? {}) as never));

  test('is not used: the runtime never receives its values', async () => {
    await saveCredentialBinding('shared', alice.username, definition, values);
    const connect = jest.fn(async () => child());
    const pool = new PrincipalRuntimeService(connect, jest.fn());
    const first = await pool.acquire('shared', alice);
    first.release();
    expect(JSON.stringify(connect.mock.calls)).toContain(SENTINEL);

    // An administrator points the same server somewhere else.
    definition = { ...definition, env: { ...definition.env, HTTPS_PROXY: 'http://evil:3128' } };
    const reconnect = jest.fn(async () => child());
    const next = new PrincipalRuntimeService(reconnect, jest.fn());
    const failure = await next.acquire('shared', alice).catch((error) => error);
    expect(failure).toBeInstanceOf(StaleCredentialError);
    expect(failure).toBeInstanceOf(MissingCredentialError);
    expect(failure.message).toContain('changed');
    expect(failure.message).not.toContain(SENTINEL);
    expect(reconnect).not.toHaveBeenCalled();
    expect(JSON.stringify(reconnect.mock.calls)).not.toContain(SENTINEL);
  });

  test('is told apart from one that was never configured', async () => {
    await saveCredentialBinding('shared', alice.username, definition, values);
    const moved = { ...definition, command: 'deno' };
    const stale = await resolveCredentialBinding('shared', alice.username, moved).catch((e) => e);
    const never = await resolveCredentialBinding('shared', 'bob@example.com', moved).catch(
      (e) => e,
    );
    expect(stale).toBeInstanceOf(StaleCredentialError);
    expect(never).toBeInstanceOf(MissingCredentialError);
    expect(never).not.toBeInstanceOf(StaleCredentialError);
    expect(stale.message).not.toBe(never.message);
    expect(stale.message).toContain(systemConfig ? 'workspace' : 'Dashboard');
  });

  test('is not deleted, and re-saving fixes it', async () => {
    await saveCredentialBinding('shared', alice.username, definition, values);
    const moved = { ...definition, command: 'deno' };
    await expect(resolveCredentialBinding('shared', alice.username, moved)).rejects.toBeInstanceOf(
      StaleCredentialError,
    );
    expect(await dao().get('shared', alice.username)).not.toBeNull();

    await saveCredentialBinding('shared', alice.username, moved, {
      ...values,
      'env.PERSONAL_KEY': 'new-value',
    });
    const resolved = await resolveCredentialBinding('shared', alice.username, moved);
    expect(resolved.config.env?.PERSONAL_KEY).toBe('new-value');
  });

  test('is reported as not configured and stale by the status', async () => {
    await saveCredentialBinding('shared', alice.username, definition, values);
    expect(await getCredentialBindingStatus('shared', alice.username, definition)).toEqual(
      expect.objectContaining({ configured: true }),
    );
    const moved = { ...definition, args: ['other.js', '--key={{args.TOKEN}}'] };
    expect(await getCredentialBindingStatus('shared', alice.username, moved)).toEqual({
      configured: false,
      configuredSlots: [],
      updatedAt: expect.any(String),
      stale: true,
    });
    // The status is judged against the stored declaration, whatever config the caller holds.
    expect(await getPersonalAuthState({ username: alice.username }, 'shared', definition)).toBe(
      'configured',
    );
    definition = { ...definition, ...moved };
    expect(await getPersonalAuthState({ username: alice.username }, 'shared', definition)).toBe(
      'stale',
    );
  });
});

describe('needs_auth status for a changed destination', () => {
  const resolve = (personalAuth: 'stale' | 'missing') =>
    resolveUserServerState({
      selected: true,
      enabled: true,
      personalAuth,
      sharedConnectionFailed: false,
    });

  test('is needs_auth with its own reason and message', () => {
    const changed = buildUserServerStatus(resolve('stale'), 'shared', 'en');
    const missing = buildUserServerStatus(resolve('missing'), 'shared', 'en');
    expect(changed).toEqual(
      expect.objectContaining({
        code: 'needs_auth',
        action: 'connect',
        reason: 'destination_changed',
      }),
    );
    expect(missing.reason).toBeUndefined();
    expect(changed.message).toContain('connection settings');
    expect(changed.message).not.toBe(missing.message);
  });

  test.each(['zh', 'fr', 'es', 'tr', 'vi'])('has a translated message in %s', (language) => {
    const changed = buildUserServerStatus(resolve('stale'), 'shared', language);
    expect(changed.message).not.toBe(
      buildUserServerStatus(resolve('stale'), 'shared', 'en').message,
    );
    expect(changed.message).toContain('shared');
    expect(changed.message).not.toContain('needsAuthChanged');
  });
});

describe('bindings stored before fingerprints existed', () => {
  const legacy = async (username = alice.username, serverName = 'shared') => {
    await dao().save({
      serverName,
      username,
      encryptedValues: await encryptCredentialValues(serverName, username, values),
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  };

  test('are stale until the startup pass, and never adopted on first use', async () => {
    await legacy();
    await expect(
      resolveCredentialBinding('shared', alice.username, definition),
    ).rejects.toBeInstanceOf(StaleCredentialError);
    expect((await dao().get('shared', alice.username))?.destinationFingerprint).toBeUndefined();
    expect(await getCredentialBindingStatus('shared', alice.username, definition)).toEqual(
      expect.objectContaining({ configured: false, stale: true }),
    );
  });

  test('the startup pass stamps them with the current declaration, so they keep working', async () => {
    await legacy();
    servers.set('shared', definition);
    expect(await stampLegacyBindings()).toEqual({ stamped: 1, orphaned: 0, skipped: 0 });
    const stored = await dao().get('shared', alice.username);
    expect(stored?.destinationFingerprint).toBe(await fingerprintOf(definition));
    const resolved = await resolveCredentialBinding('shared', alice.username, definition);
    expect(resolved.config.env?.PERSONAL_KEY).toBe(SENTINEL);
    // The ciphertext, and so the runtime revision, is untouched.
    expect(stored?.encryptedValues).toBe(resolved.revision);
    // And a later change is seen as one.
    await expect(
      resolveCredentialBinding('shared', alice.username, { ...definition, command: 'deno' }),
    ).rejects.toBeInstanceOf(StaleCredentialError);
  });

  test('the pass marks bindings of a missing server orphaned, without deleting them', async () => {
    await legacy(alice.username, 'gone');
    expect(await stampLegacyBindings()).toEqual({ stamped: 0, orphaned: 1, skipped: 0 });
    expect((await dao().get('gone', alice.username))?.destinationFingerprint).toBe(
      ORPHANED_FINGERPRINT,
    );
  });

  test('the pass skips a binding it cannot decrypt, which stays stale', async () => {
    servers.set('shared', definition);
    await dao().save({
      serverName: 'shared',
      username: alice.username,
      encryptedValues: 'v1.AAAA.AAAA.AAAA',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await stampLegacyBindings()).toEqual({ stamped: 0, orphaned: 0, skipped: 1 });
    expect((await dao().get('shared', alice.username))?.destinationFingerprint).toBeUndefined();
  });

  test('the pass leaves personal OAuth rows and already stamped bindings alone', async () => {
    servers.set('shared', definition);
    servers.set('oauth-server', {
      name: 'oauth-server',
      type: 'sse',
      url: 'https://x.example.com',
      oauth: { identityMode: 'personal' },
    });
    await legacy(alice.username, 'oauth-server');
    await saveCredentialBinding('shared', 'bob@example.com', definition, values);
    const before = await dao().get('shared', 'bob@example.com');
    expect(await stampLegacyBindings()).toEqual({ stamped: 0, orphaned: 0, skipped: 1 });
    expect(await dao().get('shared', 'bob@example.com')).toEqual(before);
    expect(
      (await dao().get('oauth-server', alice.username))?.destinationFingerprint,
    ).toBeUndefined();
  });

  test('two instances stamping at once write each binding once', async () => {
    await legacy();
    servers.set('shared', definition);
    const [first, second] = await Promise.all([stampLegacyBindings(), stampLegacyBindings()]);
    expect(first.stamped + second.stamped).toBe(1);
    expect((await dao().get('shared', alice.username))?.destinationFingerprint).toBe(
      await fingerprintOf(definition),
    );
  });

  test('conditional adoption keeps an existing fingerprint and refuses a replaced ciphertext', async () => {
    await legacy();
    const row = (await dao().get('shared', alice.username))!;
    expect(await dao().adoptDestinationFingerprint('shared', alice.username, 'other', 'v1:a')).toBe(
      false,
    );
    expect(
      await dao().adoptDestinationFingerprint(
        'shared',
        alice.username,
        row.encryptedValues,
        'v1:a',
      ),
    ).toBe(true);
    expect(
      await dao().adoptDestinationFingerprint(
        'shared',
        alice.username,
        row.encryptedValues,
        'v1:b',
      ),
    ).toBe(false);
    expect((await dao().get('shared', alice.username))?.destinationFingerprint).toBe('v1:a');
  });
});

describe('a server re-created under the name of an earlier one', () => {
  test('does not inherit the earlier bindings, even with the same declaration', async () => {
    await saveCredentialBinding('shared', alice.username, definition, values);
    await expect(
      resolveCredentialBinding('shared', alice.username, definition),
    ).resolves.toBeDefined();
    await retireServerBindings('shared');
    expect((await dao().get('shared', alice.username))?.destinationFingerprint).toBe(
      ORPHANED_FINGERPRINT,
    );
    await expect(
      resolveCredentialBinding('shared', alice.username, definition),
    ).rejects.toBeInstanceOf(StaleCredentialError);
  });

  test('does not match with another declaration either', async () => {
    await saveCredentialBinding('shared', alice.username, definition, values);
    const recreated = { ...definition, command: 'deno' };
    await expect(
      resolveCredentialBinding('shared', alice.username, recreated),
    ).rejects.toBeInstanceOf(StaleCredentialError);
  });
});

describe('listValidBindingUsers', () => {
  test('lists only users whose binding is valid for the declaration now', async () => {
    await saveCredentialBinding('shared', 'a@example.com', definition, values);
    await saveCredentialBinding(
      'shared',
      'b@example.com',
      { ...definition, command: 'deno' },
      values,
    );
    await dao().save({
      serverName: 'shared',
      username: 'c@example.com',
      encryptedValues: await encryptCredentialValues('shared', 'c@example.com', values),
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(await listValidBindingUsers('shared', definition)).toEqual(['a@example.com']);
  });
});

test('saving stores the fingerprint of the declaration it was made against', async () => {
  await saveCredentialBinding('shared', alice.username, definition, values);
  expect((await dao().get('shared', alice.username))?.destinationFingerprint).toBe(
    await fingerprintOf(definition),
  );
  expect(
    fs.readFileSync(`${process.env.MCPHUB_SETTING_PATH}.credentials.json`, 'utf8'),
  ).not.toContain('proxy-a');
});

test('stale classification is a missing credential, not a configuration fault', () => {
  expect(new StaleCredentialError('x')).toBeInstanceOf(CredentialBindingError);
  expect(new StaleCredentialError('x')).toBeInstanceOf(MissingCredentialError);
});

test('a plain rename keeps the fingerprint, so the copied binding stays valid', async () => {
  await saveCredentialBinding('shared', alice.username, definition, values);
  await copyCredentialBindings('shared', 'renamed');
  const copy = await dao().get('renamed', alice.username);
  expect(copy?.destinationFingerprint).toBe(await fingerprintOf(definition));
  expect(
    (await resolveCredentialBinding('renamed', alice.username, definition)).config.env
      ?.PERSONAL_KEY,
  ).toBe(SENTINEL);
});

describe('environment references in the declaration', () => {
  afterEach(() => {
    delete process.env.DEST_TEST_HOST;
  });

  test('are fingerprinted as the runtime expands them, and a moved reference makes bindings stale', async () => {
    process.env.DEST_TEST_HOST = 'a.example.com';
    definition = {
      name: 'shared',
      ...remote,
      url: 'https://${DEST_TEST_HOST}/mcp',
    };
    await saveCredentialBinding('shared', alice.username, definition, {
      'headers.Authorization': 'Bearer mine',
    });
    // The runtime also re-resolves after connecting; that check must see the same declaration.
    const connect = jest.fn(async () => child());
    const pool = new PrincipalRuntimeService(connect, jest.fn());
    (await pool.acquire('shared', alice)).release();
    expect(connect).toHaveBeenCalledTimes(1);

    process.env.DEST_TEST_HOST = 'evil.example.com';
    const other = new PrincipalRuntimeService(jest.fn(), jest.fn());
    await expect(other.acquire('shared', alice)).rejects.toBeInstanceOf(StaleCredentialError);
  });
});

describe('one fingerprint on every path', () => {
  afterEach(() => {
    delete process.env.DEST_PARITY_VAR;
  });
  const variants: Array<[string, () => ServerConfig]> = [
    [
      'stdio with whitespace in env and args',
      () => ({
        type: 'stdio',
        command: ' node ',
        args: ['  server.js ', '--key={{args.TOKEN}} '],
        env: { PERSONAL_KEY: ' placeholder ', REGION: '  eu  ' },
        owner: 'admin',
        visibility: 'public',
        credentialTemplate: [
          { target: 'env', name: 'PERSONAL_KEY' },
          { target: 'args', name: 'TOKEN' },
        ],
      }),
    ],
    [
      'stdio with a ${VAR} reference and whitespace',
      () => ({
        type: 'stdio',
        command: 'node',
        args: [' ${DEST_PARITY_VAR} ', '--key={{args.TOKEN}}'],
        env: { PERSONAL_KEY: 'p', REGION: ' ${DEST_PARITY_VAR}  ' },
        owner: 'admin',
        visibility: 'public',
        credentialTemplate: [
          { target: 'env', name: 'PERSONAL_KEY' },
          { target: 'args', name: 'TOKEN' },
        ],
      }),
    ],
    [
      'http with whitespace in the url and headers',
      () => ({
        type: 'streamable-http',
        url: '  https://api.example.com/mcp  ',
        headers: { Authorization: 'org', 'X-Region': '  eu ' },
        owner: 'admin',
        visibility: 'public',
        credentialTemplate: [{ target: 'headers', name: 'Authorization' }],
      }),
    ],
    [
      'http with a ${VAR} reference in the url',
      () => ({
        type: 'sse',
        url: 'https://${DEST_PARITY_VAR}/mcp ',
        headers: { Authorization: 'org', 'X-Zone': ' ${DEST_PARITY_VAR} ' },
        owner: 'admin',
        visibility: 'public',
        credentialTemplate: [{ target: 'headers', name: 'Authorization' }],
      }),
    ],
    [
      'openapi with whitespace in the schema',
      () => ({
        type: 'openapi',
        openapi: {
          schema: {
            openapi: '3.0.0',
            info: { title: '  Pets  ', version: '1' },
            servers: [{ url: ' https://pets.example.com ' }],
            paths: {},
          },
        },
        headers: { Authorization: 'org' },
        owner: 'admin',
        visibility: 'public',
        credentialTemplate: [{ target: 'headers', name: 'Authorization' }],
      }),
    ],
  ];
  const slotValues = (config: ServerConfig) =>
    Object.fromEntries(
      (config.credentialTemplate ?? []).map((slot) => [`${slot.target}.${slot.name}`, 'value']),
    );

  test.each(variants)(
    '%s: save, status, runtime, stamping and edit comparison agree',
    async (_n, make) => {
      process.env.DEST_PARITY_VAR = 'host.example.com';
      definition = { name: 'shared', ...make() };
      await saveCredentialBinding('shared', alice.username, definition, slotValues(definition));
      const saved = (await dao().get('shared', alice.username))!.destinationFingerprint;
      // Save and every later computation come from the same stored definition.
      expect(saved).toBe(await fingerprintOf(definition));
      expect(await getCredentialBindingStatus('shared', alice.username, definition)).toEqual(
        expect.objectContaining({ configured: true }),
      );
      expect(await getPersonalAuthState({ username: alice.username }, 'shared', definition)).toBe(
        'configured',
      );
      const pool = new PrincipalRuntimeService(
        jest.fn(async () => child()),
        jest.fn(),
      );
      (await pool.acquire('shared', alice)).release();

      // A description-only edit never changes the destination.
      const edited = { ...definition, description: 'a new note', visibility: 'private' as const };
      expect(await canonicalDestination(edited)).toBe(await canonicalDestination(definition));
      definition = edited;
      expect(await getCredentialBindingStatus('shared', alice.username, edited)).toEqual(
        expect.objectContaining({ configured: true }),
      );
      await expect(
        resolveCredentialBinding('shared', alice.username, edited),
      ).resolves.toBeDefined();
      expect(await listValidBindingUsers('shared', edited)).toEqual([alice.username]);

      // Stamping an unstamped copy of the same binding lands on the same value.
      const row = (await dao().get('shared', alice.username))!;
      await dao().save({
        ...row,
        username: 'legacy@example.com',
        destinationFingerprint: undefined,
        encryptedValues: await encryptCredentialValues(
          'shared',
          'legacy@example.com',
          slotValues(edited),
        ),
      });
      servers.set('shared', definition);
      await stampLegacyBindings();
      expect((await dao().get('shared', 'legacy@example.com'))?.destinationFingerprint).toBe(saved);
    },
  );

  test('the expansion happens once: an expanded copy is not what the paths fingerprint', async () => {
    process.env.DEST_PARITY_VAR = ' padded ';
    definition = { name: 'shared', ...variants[1][1]() };
    await saveCredentialBinding('shared', alice.username, definition, slotValues(definition));
    const { expandServerConfig } = await import('../../src/services/serverConfigEnvironment.js');
    const expanded = await expandServerConfig(definition);
    // Same canonical form either way for whitespace-only differences...
    expect(canonicalCredentialDestination(expanded)).toBe(await canonicalDestination(definition));
    // ...and the raw definition is what every entry point accepts.
    await expect(
      resolveCredentialBinding('shared', alice.username, definition),
    ).resolves.toBeDefined();
  });
});

describe('the status of a URL-slot server', () => {
  const urlServer: ServerConfig = {
    type: 'streamable-http',
    url: 'https://mcp.{{url.region}}.example.com/mcp',
    owner: 'admin',
    visibility: 'public',
    credentialTemplate: [
      { target: 'url', name: 'region', allowed: ['us', 'eu'] },
      { target: 'headers', name: 'X-Api-Key' },
    ],
  };

  test('is judged on the unresolved declaration, so a rejected credential is not stale', async () => {
    definition = { name: 'shared', ...urlServer };
    await saveCredentialBinding('shared', alice.username, definition, {
      'url.region': 'us',
      'headers.X-Api-Key': 'k',
    });
    const resolved = await resolveCredentialBinding('shared', alice.username, definition);
    expect(resolved.config.url).toBe('https://mcp.us.example.com/mcp');
    // A caller holding the resolved copy (as a personal runtime's info does) must not make the
    // binding look stale.
    const state = await getPersonalAuthState(
      { username: alice.username },
      'shared',
      resolved.config,
    );
    expect(state).toBe('configured');
    const status = resolveUserServerState({
      selected: true,
      enabled: true,
      personalAuth: state,
      sharedConnectionFailed: false,
      failure: { kind: 'auth', at: Date.now() },
    });
    expect(status.code).toBe('credential_invalid');
    expect(status.reason).toBeUndefined();
  });
});
