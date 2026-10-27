// Two-user isolation, end to end.
//
// A real MCPHub application (`AppServer`: real routes, auth middlewares, session handling,
// selection / status / risk / pause / client-revocation logic and credential store, JSON mode)
// with Workspace Mode on, talking to real upstream MCP servers over loopback HTTP, driven by a
// real MCP client (streamable HTTP, user-level bearer keys) and the real dashboard API (signed
// session tokens). Nothing under test is mocked. Only side services that need infrastructure
// are replaced: the OAuth/vector-search start-up hooks, and the activity log sink, which is
// replaced by a recorder so the rows the call sites hand to it can be inspected.
//
// What is NOT end to end, on purpose:
//  - Database mode: needs a disposable PostgreSQL (see personal-oauth-db.test.ts), not available
//    to a default run. The JSON-file store is exercised instead, including its sidecars.
//  - My Activity: the history endpoint exists only in database mode (here it answers
//    `available: false`). Per-user separation of the recorded rows is therefore checked at the
//    layer just below, on the rows the real call sites pass to the activity logger.
//
// Scenarios run in order and share one running app (restart is scenario 7); each starts from
// `reset()`, so none depends on another's leftovers except the log scan in scenario 8, which
// covers everything captured since start-up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { randomBytes } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import {
  fingerprint,
  readSettings,
  startHub,
  startUpstreams,
  type Hub,
  type Upstreams,
} from './two-user-isolation.harness.js';

jest.mock('openid-client', () => ({}));
jest.mock('../../src/services/oauthService.js', () => ({
  __esModule: true,
  initializeAllOAuthClients: jest.fn(),
  initOAuthProvider: jest.fn(),
  getOAuthRouter: jest.fn(() => null),
}));
jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  removeToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn(),
  syncAllServerToolsEmbeddings: jest.fn(),
}));
const mockActivityRows: Array<Record<string, any>> = [];
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: () => ({
    logToolCall: jest.fn(async (row: Record<string, any>) => {
      mockActivityRows.push(row);
    }),
  }),
}));

const SERVERS = ['shared', 'personal', 'maint'] as const;
const SLOT = 'headers.X-Personal-Key';
// Distinctive credential values; none may appear in any log line, activity row or response.
const secret = {
  alice: `ALICE-${randomBytes(6).toString('hex')}`,
  bob: `BOB-${randomBytes(6).toString('hex')}`,
};
const bearer = (key: string) => `${key}-secret-token`;
const KEYS = [
  ['alice-laptop', 'alice'],
  ['alice-phone', 'alice'],
  ['alice-tablet', 'alice'],
  ['bob-laptop', 'bob'],
];
const serverConfig = (upstreams: Upstreams, name: string, extra: object = {}) => ({
  type: 'streamable-http',
  url: `${upstreams.baseUrl}/${name}`,
  owner: 'admin',
  visibility: 'public',
  ...extra,
});

let directory: string;
let settingsPath: string;
let upstreams: Upstreams;
let hub: Hub;
const captured: string[] = [];
const spies: jest.SpyInstance[] = [];

beforeAll(async () => {
  // Capture everything the application writes through the console (the logger's sink).
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    spies.push(
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(
          util.inspect(args, { depth: 8, maxStringLength: null, breakLength: Infinity }),
        );
      }),
    );
  }
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-isolation-'));
  settingsPath = path.join(directory, 'mcp_settings.json');
  process.env.USE_DB = 'false';
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  upstreams = await startUpstreams();
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      mcpServers: {
        shared: serverConfig(upstreams, 'shared'),
        personal: serverConfig(upstreams, 'personal', {
          credentialTemplate: [{ target: 'headers', name: 'X-Personal-Key' }],
        }),
        maint: serverConfig(upstreams, 'maint'),
      },
      users: ['alice', 'bob', 'admin'].map((username) => ({
        username,
        password: 'unused',
        isAdmin: username === 'admin',
      })),
      groups: [],
      bearerKeys: KEYS.map(([id, owner]) => ({
        id,
        name: id,
        token: bearer(id),
        kind: 'user',
        owner,
        enabled: true,
        accessType: 'all',
        createdAt: new Date().toISOString(),
      })),
      systemConfig: {
        routing: {
          enableGlobalRoute: true,
          enableGroupNameRoute: true,
          enableBearerAuth: true,
          skipAuth: false,
        },
        workspace: { enabled: true },
        oauthServer: { enabled: false },
      },
    }),
  );
  hub = await startHub(settingsPath, ['shared', 'maint']);
}, 60000);

afterAll(async () => {
  await hub?.stop();
  await upstreams?.close();
  for (const spy of spies) spy.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.USE_DB;
});

// ---- helpers -------------------------------------------------------------------------------

const toolNames = async (client: Client) =>
  (await client.listTools()).tools.map((t) => t.name).sort();
const call = (client: Client, name: string) =>
  client.callTool({ name, arguments: {} }) as Promise<any>;
const statusOf = (result: any) => result?._meta?.['mcphub/status'];
const echo = (result: any) =>
  JSON.parse(result.content[0].text) as { server: string; tool: string; fingerprint?: string };
const select = async (user: string, server: string, selected = true) =>
  expect(
    (await hub.api('put', `/api/workspace/servers/${server}/selection`, user, { selected })).status,
  ).toBe(200);
const ceiling = async (user: string, server: string, riskCeiling: string) =>
  expect(
    (await hub.api('put', `/api/workspace/servers/${server}/risk`, user, { riskCeiling })).status,
  ).toBe(200);
const bind = async (user: 'alice' | 'bob') =>
  expect(
    (await hub.api('put', '/api/credentials/personal', user, { values: { [SLOT]: secret[user] } }))
      .status,
  ).toBe(200);
const adminServer = (name: string, patch: object) =>
  hub.api('put', `/api/servers/${name}`, 'admin', {
    config: { ...serverConfig(upstreams, name), ...patch },
  });
const eventually = async <T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 5000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }
  return value;
};
let adminTouched = false;
const reset = async () => {
  for (const user of ['alice', 'bob'] as const) {
    await hub.api('delete', '/api/credentials/personal', user);
    for (const server of SERVERS) {
      await select(user, server, false);
      await ceiling(user, server, 'read');
    }
  }
  if (adminTouched) {
    for (const server of ['shared', 'maint']) {
      expect((await adminServer(server, { pausedUsers: [], maintenance: null })).status).toBe(200);
    }
    adminTouched = false;
  }
};
const rawMcpStatus = async (endpointUser: string, token: string) =>
  (
    await fetch(`${hub.baseUrl}/${endpointUser}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'x', version: '1' },
        },
      }),
    })
  ).status;

beforeEach(reset);

// ---- scenarios -----------------------------------------------------------------------------

describe('two users, one hub', () => {
  it("1. selection isolation: each endpoint lists only its own user's selection", async () => {
    await select('alice', 'shared');
    await select('alice', 'personal');
    await bind('alice');
    await select('bob', 'shared');
    const alice = await hub.connect('alice', bearer('alice-laptop'));
    const bob = await hub.connect('bob', bearer('bob-laptop'));

    expect(await toolNames(alice)).toEqual(['personal-whoami', 'shared-lookup']);
    expect(await toolNames(bob)).toEqual(['shared-lookup']);

    // A later change by one user moves only that user's endpoint, on the same URL and session.
    await select('bob', 'maint');
    expect(await toolNames(bob)).toEqual(['maint-ping', 'shared-lookup']);
    expect(await toolNames(alice)).toEqual(['personal-whoami', 'shared-lookup']);

    // The dashboard view agrees, per user.
    const view = async (user: string) =>
      Object.fromEntries(
        (await hub.api('get', '/api/workspace/servers', user)).body.data.map((s: any) => [
          s.name,
          s.selected,
        ]),
      );
    expect(await view('alice')).toEqual({ shared: true, personal: true, maint: false });
    expect(await view('bob')).toEqual({ shared: true, personal: false, maint: true });
  });

  it("2. credential isolation: every call reaches the upstream with the caller's own credential", async () => {
    for (const user of ['alice', 'bob'] as const) {
      await select(user, 'personal');
      await bind(user);
    }
    const alice = await hub.connect('alice', bearer('alice-laptop'));
    const bob = await hub.connect('bob', bearer('bob-laptop'));
    const [a, b] = await Promise.all([
      call(alice, 'personal-whoami'),
      call(bob, 'personal-whoami'),
    ]);
    expect(echo(a).fingerprint).toBe(fingerprint(secret.alice));
    expect(echo(b).fingerprint).toBe(fingerprint(secret.bob));
    expect(echo(a).fingerprint).not.toBe(echo(b).fingerprint);
    // The upstream's own record agrees, and the order of calls does not matter.
    expect(await call(alice, 'personal-whoami').then((r) => echo(r).fingerprint)).toBe(
      fingerprint(secret.alice),
    );
    const seen = upstreams.calls.filter((c) => c.server === 'personal' && c.tool === 'whoami');
    expect(new Set(seen.map((c) => c.fingerprint))).toEqual(
      new Set([fingerprint(secret.alice), fingerprint(secret.bob)]),
    );

    // Bob cannot use alice's endpoint, with his key or his dashboard session.
    expect(await rawMcpStatus('alice', bearer('bob-laptop'))).toBe(403);
    expect(await rawMcpStatus('bob', bearer('alice-laptop'))).toBe(403);
    expect((await hub.api('get', '/alice/mcp', 'bob')).status).toBe(403);

    // Credential status is per caller: only alice has bound here, and nothing bob sends
    // (a username in the query or body) lets him read hers.
    await hub.api('delete', '/api/credentials/personal', 'bob');
    const statusFor = async (user: string, suffix = '') =>
      (await hub.api('get', `/api/credentials${suffix}`, user)).body.data.find(
        (s: any) => s.serverName === 'personal',
      );
    expect((await statusFor('alice')).configured).toBe(true);
    expect((await statusFor('bob')).configured).toBe(false);
    expect((await statusFor('bob', '?username=alice')).configured).toBe(false);
    const forged = await hub.api('put', '/api/credentials/personal', 'bob', {
      username: 'alice',
      values: { [SLOT]: 'bob-writes-here' },
    });
    expect(forged.status).toBe(200);
    expect(echo(await call(alice, 'personal-whoami')).fingerprint).toBe(fingerprint(secret.alice));
    expect(echo(await call(bob, 'personal-whoami')).fingerprint).toBe(
      fingerprint('bob-writes-here'),
    );
  });

  it('3. status: selected but unbound answers needs_auth with _meta; binding fixes it', async () => {
    await select('bob', 'personal');
    const bob = await hub.connect('bob', bearer('bob-laptop'));
    const blocked = await call(bob, 'personal-whoami');
    expect(blocked.isError).toBe(true);
    expect(statusOf(blocked)).toMatchObject({
      server: 'personal',
      code: 'needs_auth',
      action: 'connect',
    });
    expect(
      upstreams.calls.filter((c) => c.server === 'personal' && c.fingerprint === undefined),
    ).toEqual([]);

    await bind('bob');
    const ok = await call(bob, 'personal-whoami');
    expect(ok.isError).toBeFalsy();
    expect(echo(ok).fingerprint).toBe(fingerprint(secret.bob));
    expect(await toolNames(bob)).toEqual(['personal-whoami']);
  });

  it('4. risk: the default read ceiling hides write tools; raising it affects only the raiser', async () => {
    await select('alice', 'shared');
    await select('bob', 'shared');
    const alice = await hub.connect('alice', bearer('alice-laptop'));
    const bob = await hub.connect('bob', bearer('bob-laptop'));
    expect(await toolNames(alice)).toEqual(['shared-lookup']);
    expect(await toolNames(bob)).toEqual(['shared-lookup']);

    await ceiling('alice', 'shared', 'write');
    expect(await toolNames(alice)).toEqual(['shared-lookup', 'shared-save_note']);
    expect(await toolNames(bob)).toEqual(['shared-lookup']);

    const before = upstreams.calls.length;
    const refused = await call(bob, 'shared-save_note');
    expect(refused.isError).toBe(true);
    expect(statusOf(refused)).toMatchObject({
      server: 'shared',
      code: 'risk_not_enabled',
      action: 'enable_risk',
    });
    expect(upstreams.calls.length).toBe(before);
    expect(echo(await call(alice, 'shared-save_note'))).toMatchObject({
      server: 'shared',
      tool: 'save_note',
    });
    // An external tool stays out of reach until alice goes all the way.
    expect((await call(alice, 'shared-send_email')).isError).toBe(true);
  });

  it('5. revocation: a removed credential and a revoked client stop working at once, for one user only', async () => {
    for (const user of ['alice', 'bob'] as const) {
      await select(user, 'personal');
      await bind(user);
    }
    const alice = await hub.connect('alice', bearer('alice-laptop'));
    const phone = await hub.connect('alice', bearer('alice-phone'));
    const bob = await hub.connect('bob', bearer('bob-laptop'));
    expect(echo(await call(alice, 'personal-whoami')).fingerprint).toBe(fingerprint(secret.alice));

    // Alice removes her credential: same session, next call.
    expect((await hub.api('delete', '/api/credentials/personal', 'alice')).status).toBe(200);
    const after = await eventually(
      () => call(alice, 'personal-whoami'),
      (r) => statusOf(r)?.code === 'needs_auth',
    );
    expect(after.isError).toBe(true);
    expect(statusOf(after)).toMatchObject({ code: 'needs_auth' });
    expect(echo(await call(bob, 'personal-whoami')).fingerprint).toBe(fingerprint(secret.bob));

    // Client revocation. Bob cannot revoke alice's key (same answer as for a key that is not there).
    const listed = (await hub.api('get', '/api/workspace/clients', 'alice')).body.data;
    expect(listed.map((c: any) => c.id).sort()).toEqual(
      expect.arrayContaining(['alice-laptop', 'alice-phone', 'alice-tablet']),
    );
    expect(JSON.stringify(listed)).not.toContain('bob-laptop');
    expect((await hub.api('delete', '/api/workspace/clients/key/alice-phone', 'bob')).status).toBe(
      404,
    );
    expect(
      (await hub.api('get', '/api/workspace/clients', 'bob')).body.data.map((c: any) => c.id),
    ).toEqual(['bob-laptop']);
    await select('alice', 'shared');
    expect(echo(await call(phone, 'shared-lookup')).tool).toBe('lookup'); // still alive

    expect(
      (await hub.api('delete', '/api/workspace/clients/key/alice-phone', 'alice')).status,
    ).toBe(200);
    await expect(call(phone, 'personal-whoami')).rejects.toBeDefined();
    await expect(hub.connect('alice', bearer('alice-phone'))).rejects.toBeDefined();
    expect(await rawMcpStatus('alice', bearer('alice-phone'))).toBe(401);
    // Her other client and her endpoint URL are unaffected, and so is bob.
    expect(await toolNames(alice)).toEqual(['shared-lookup']);
    expect(await toolNames(bob)).toEqual(['personal-whoami']);
  });

  it('6. admin controls: pausing a server for bob leaves alice alone; maintenance hits everyone', async () => {
    for (const user of ['alice', 'bob']) {
      await select(user, 'shared');
      await select(user, 'maint');
    }
    const alice = await hub.connect('alice', bearer('alice-laptop'));
    const bob = await hub.connect('bob', bearer('bob-laptop'));
    expect(await toolNames(bob)).toEqual(['maint-ping', 'shared-lookup']);

    // Only an administrator can pause.
    const asBob = await hub.api('put', '/api/servers/shared', 'bob', {
      config: { ...serverConfig(upstreams, 'shared'), pausedUsers: ['alice'] },
    });
    expect(asBob.status).toBe(403);
    expect(await toolNames(alice)).toEqual(['maint-ping', 'shared-lookup']);

    adminTouched = true;
    expect((await adminServer('shared', { pausedUsers: ['bob'] })).status).toBe(200);
    const bobList = await eventually(
      () => toolNames(bob),
      (names) => !names.includes('shared-lookup'),
    );
    expect(bobList).toEqual(['maint-ping']);
    expect(await toolNames(alice)).toEqual(['maint-ping', 'shared-lookup']);
    const before = upstreams.calls.length;
    const refused = await call(bob, 'shared-lookup');
    expect(refused.isError).toBe(true);
    expect(statusOf(refused)).toMatchObject({
      server: 'shared',
      code: 'paused',
      action: 'contact_admin',
    });
    expect(upstreams.calls.length).toBe(before);
    expect(echo(await call(alice, 'shared-lookup')).tool).toBe('lookup');

    // A maintenance window on the other server removes it for both users.
    const until = new Date(Date.now() + 3600_000).toISOString();
    expect(
      (await adminServer('maint', { maintenance: { until, message: 'upgrading' } })).status,
    ).toBe(200);
    for (const client of [alice, bob]) {
      const names = await eventually(
        () => toolNames(client),
        (n) => !n.includes('maint-ping'),
      );
      expect(names).not.toContain('maint-ping');
      const result = await call(client, 'maint-ping');
      expect(result.isError).toBe(true);
      expect(statusOf(result)).toMatchObject({
        server: 'maint',
        code: 'maintenance',
        action: 'retry_later',
      });
    }
  });

  it('7. restart: selections, ceilings, bindings and clients survive; isolation still holds', async () => {
    await select('alice', 'shared');
    await select('alice', 'personal');
    await ceiling('alice', 'shared', 'write');
    await bind('alice');
    await select('bob', 'shared');
    await select('bob', 'personal');
    await bind('bob');
    for (const key of ['alice-laptop', 'alice-tablet'])
      await toolNames(await hub.connect('alice', bearer(key)));

    const snapshot = async () => ({
      servers: Object.fromEntries(
        (await hub.api('get', '/api/workspace/servers', 'alice')).body.data.map((s: any) => [
          s.name,
          [s.selected, s.riskCeiling],
        ]),
      ),
      credentials: (await hub.api('get', '/api/credentials', 'alice')).body.data.map((s: any) => [
        s.serverName,
        s.configured,
      ]),
      clients: (await hub.api('get', '/api/workspace/clients', 'alice')).body.data
        .map((c: any) => c.id)
        .sort(),
    });
    const readSidecar = (name: string) =>
      JSON.parse(fs.readFileSync(`${settingsPath}.${name}.json`, 'utf8')) as unknown[];
    const bindingFingerprints = () =>
      Object.fromEntries(
        (readSidecar('credentials') as any[]).map((b) => [
          `${b.username}/${b.serverName}`,
          b.destinationFingerprint,
        ]),
      );
    const before = await snapshot();
    const storedBefore = bindingFingerprints();
    expect(Object.keys(storedBefore).sort()).toEqual(['alice/personal', 'bob/personal']);
    expect(storedBefore['alice/personal']).toBeTruthy();
    // Stored encrypted: neither value is in the file.
    const rawStore = fs.readFileSync(`${settingsPath}.credentials.json`, 'utf8');
    expect([secret.alice, secret.bob].filter((value) => rawStore.includes(value))).toEqual([]);

    await hub.stop();
    hub = await startHub(settingsPath, ['shared', 'maint']);

    expect(await snapshot()).toEqual(before);
    expect(bindingFingerprints()).toEqual(storedBefore);
    // Bearer keys are stored hashed, and the same tokens still work after the restart.
    expect(JSON.stringify(readSettings(settingsPath).bearerKeys)).not.toContain(
      bearer('alice-laptop'),
    );
    const alice = await hub.connect('alice', bearer('alice-laptop'));
    const tablet = await hub.connect('alice', bearer('alice-tablet'));
    const bob = await hub.connect('bob', bearer('bob-laptop'));
    // Scenarios 1 and 2 again, against the restarted application.
    expect(await toolNames(alice)).toEqual([
      'personal-whoami',
      'shared-lookup',
      'shared-save_note',
    ]);
    expect(await toolNames(tablet)).toEqual(await toolNames(alice));
    expect(await toolNames(bob)).toEqual(['personal-whoami', 'shared-lookup']);
    expect(echo(await call(alice, 'personal-whoami')).fingerprint).toBe(fingerprint(secret.alice));
    expect(echo(await call(bob, 'personal-whoami')).fingerprint).toBe(fingerprint(secret.bob));
    expect(await rawMcpStatus('alice', bearer('bob-laptop'))).toBe(403);
  });

  it("8. logs and activity: no credential value leaks; each user's activity is their own", async () => {
    for (const user of ['alice', 'bob'] as const) {
      await select(user, 'personal');
      await bind(user);
    }
    const alice = await hub.connect('alice', bearer('alice-laptop'));
    const bob = await hub.connect('bob', bearer('bob-laptop'));
    mockActivityRows.length = 0;
    await call(alice, 'personal-whoami');
    await call(bob, 'personal-whoami');
    await hub.api('delete', '/api/credentials/personal', 'bob');
    await call(bob, 'personal-whoami'); // blocked: needs_auth

    // Everything logged since the application first started, over every scenario above.
    const logged = captured.join('\n');
    expect(logged.length).toBeGreaterThan(1000);
    expect(logged).toContain('alice'); // the capture is live, not vacuous
    const leaks = (text: string) =>
      [secret.alice, secret.bob, 'bob-writes-here', ...KEYS.map(([id]) => bearer(id))].filter(
        (value) => text.includes(value),
      );
    expect(leaks(logged)).toEqual([]);

    // Activity rows handed to the logger by the real call sites.
    const rows = mockActivityRows.filter((row) => row.server === 'personal');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(leaks(JSON.stringify(rows))).toEqual([]);
    const byUser = (user: string) => rows.filter((row) => row.username === user);
    expect(byUser('alice')).toHaveLength(1);
    expect(byUser('bob')).toHaveLength(2);
    expect(byUser('alice').every((row) => row.clientId === 'alice-laptop')).toBe(true);
    expect(byUser('bob').every((row) => row.clientId === 'bob-laptop')).toBe(true);
    expect(
      byUser('bob')
        .map((row) => row.statusCode)
        .filter(Boolean),
    ).toEqual(['needs_auth']);
    // No row names a user other than the credential that made the call.
    expect(rows.filter((row) => !['alice', 'bob'].includes(row.username))).toEqual([]);

    // The history endpoint is database-mode only; here it must still say so to both users and
    // return no rows, in particular none of the other user's.
    for (const user of ['alice', 'bob']) {
      const history = await hub.api('get', '/api/workspace/activity', user);
      expect(history.status).toBe(200);
      expect(history.body.data).toEqual({ available: false });
    }
  });
});
