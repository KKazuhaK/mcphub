// An upstream MCP server whose authorization server is MCPHub itself (ADR 0015), end to end.
//
// A real MCPHub application (JSON mode, Workspace Mode) with the public base URL set to an
// address nothing listens on, one external resource, and an upstream server pointing at it with
// personal OAuth. The upstream is an in-process fake resource server over loopback: Streamable HTTP
// MCP with one tool that echoes the verified token's `sub`, a 401 with `resource_metadata` when the
// token is missing or invalid, and JWT validation with jose against MCPHub's real JWKS. The browser
// is played by the test (dashboard session header, redirects followed by hand). Nothing under test
// is mocked; the public URL is unreachable on purpose, which is what proves the token and metadata
// calls MCPHub makes to its own authorization server never use it.
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server as McpServer } from '@modelcontextprotocol/server';
import type { Client } from '@modelcontextprotocol/client';
import { generateCodeChallenge } from '../../src/services/oauthServerService.js';
import { readSettings, startHub, type Hub } from './two-user-isolation.harness.js';

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

const ISSUER = 'https://hub.invalid';
const SELF_CLIENT = 'mcphub-personal-oauth';
const LIFETIME_SECONDS = 2;
const bearer = (id: string) => `${id}-secret-token`;

type Seen = { sub: string; aud: unknown; clientId: unknown; scope: unknown; token: string };

let directory: string;
let settingsPath: string;
let resourceServer: HttpServer;
let resourceUrl: string;
let hub: Hub;
let seen: Seen[];
let rejected: number;
let tokenRequests: URLSearchParams[];
let tokenResponses: number[];
let fetchSpy: jest.SpyInstance;
const publicUrlFetches: string[] = [];
const clients: Client[] = [];

const startResource = async () => {
  seen = [];
  rejected = 0;
  const app = express();
  app.use(express.json());
  let jwksUrl = '';
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  const metadataUrl = () => `${resourceUrl}/.well-known/oauth-protected-resource/mcp`;
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
    res.json({
      resource: `${resourceUrl}/mcp`,
      authorization_servers: [ISSUER],
      scopes_supported: ['mcp:tools'],
    });
  });
  // A service whose metadata names some other, reachable, authorization server.
  app.get('/.well-known/oauth-protected-resource/rogue', (_req, res) => {
    res.json({ resource: `${resourceUrl}/rogue`, authorization_servers: [resourceUrl] });
  });
  app.get('/.well-known/oauth-authorization-server', (_req, res) => {
    res.json({
      issuer: resourceUrl,
      authorization_endpoint: `${resourceUrl}/authorize`,
      token_endpoint: `${resourceUrl}/token`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
    });
  });
  app.all(['/rogue', '/restricted'], (req, res) => {
    res
      .status(401)
      .set(
        'WWW-Authenticate',
        `Bearer resource_metadata="${resourceUrl}/.well-known/oauth-protected-resource${req.path}"`,
      )
      .json({ error: 'invalid_token' });
  });
  app.all('/mcp', async (req, res) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /i, '');
    // The verifier learns the key set from the issuer's metadata `jwks_uri`; the public URL is
    // unreachable here, so the same document is read from the hub's real listener.
    if (hub && jwksUrl !== hub.baseUrl) {
      jwksUrl = hub.baseUrl;
      jwks = createRemoteJWKSet(new URL(`${hub.baseUrl}/.well-known/jwks.json`));
    }
    let claims: Record<string, unknown> | undefined;
    if (token && jwks) {
      try {
        claims = (await jwtVerify(token, jwks, { issuer: ISSUER, audience: `${resourceUrl}/mcp` }))
          .payload;
      } catch {
        claims = undefined;
      }
    }
    if (!claims) {
      rejected += 1;
      res
        .status(401)
        .set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl()}"`)
        .json({ error: 'invalid_token' });
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).end();
      return;
    }
    const upstream = new McpServer(
      { name: 'fake-ubc', version: '1' },
      { capabilities: { tools: {} } },
    );
    upstream.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'whoami',
          description: 'Echo the subject of the access token',
          inputSchema: { type: 'object' as const, properties: {} },
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
      ],
    }));
    upstream.setRequestHandler('tools/call', async () => {
      const entry: Seen = {
        sub: String(claims!.sub),
        aud: claims!.aud,
        clientId: claims!.client_id,
        scope: claims!.scope,
        token,
      };
      seen.push(entry);
      return { content: [{ type: 'text', text: JSON.stringify({ sub: entry.sub }) }] };
    });
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void upstream.close();
    });
    await upstream.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  resourceServer = await new Promise<HttpServer>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  resourceUrl = `http://127.0.0.1:${(resourceServer.address() as { port: number }).port}`;
};

const KEYS = [
  ['alice-laptop', 'alice'],
  ['bob-laptop', 'bob'],
];

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-self-resource-'));
  settingsPath = path.join(directory, 'mcp_settings.json');
  process.env.USE_DB = 'false';
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  await startResource();
  tokenRequests = [];
  tokenResponses = [];
  // Record what MCPHub sends its own token endpoint (the hub's loopback listener, never the
  // unreachable public URL) without changing the exchange.
  const realFetch = global.fetch;
  fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(ISSUER)) publicUrlFetches.push(url);
    const response = await realFetch(input as any, init);
    if (url.endsWith('/oauth/token') && !url.startsWith(ISSUER)) {
      tokenRequests.push(new URLSearchParams(String(init?.body ?? '')));
      tokenResponses.push(response.status);
    }
    return response;
  });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify({
      mcpServers: {
        ubc: {
          type: 'streamable-http',
          url: `${resourceUrl}/mcp`,
          owner: 'admin',
          visibility: 'public',
          oauth: { identityMode: 'personal' },
        },
        // Redirect overrides a server's owner controls must not reach the shared client.
        'ubc-redirect': {
          type: 'streamable-http',
          url: `${resourceUrl}/mcp`,
          owner: 'admin',
          visibility: 'public',
          oauth: {
            identityMode: 'personal',
            redirectUri: 'https://evil.example/cb',
            dynamicRegistration: {
              enabled: true,
              metadata: { redirect_uris: ['https://evil.example/cb2'] },
            },
          },
        },
        'wrong-as': {
          type: 'streamable-http',
          url: `${resourceUrl}/rogue`,
          owner: 'admin',
          visibility: 'public',
          oauth: { identityMode: 'personal' },
        },
        // Predates the save-time rule: names the public client without being an external resource.
        borrow: {
          type: 'streamable-http',
          url: `${resourceUrl}/borrow`,
          owner: 'admin',
          visibility: 'public',
          oauth: { identityMode: 'personal', clientId: SELF_CLIENT },
        },
        restricted: {
          type: 'streamable-http',
          url: `${resourceUrl}/restricted`,
          owner: 'admin',
          visibility: 'public',
          oauth: { identityMode: 'personal' },
        },
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
        install: { baseUrl: ISSUER },
        oauthServer: {
          enabled: true,
          externalTokenLifetimeSeconds: LIFETIME_SECONDS,
          externalResources: [
            { resource: `${resourceUrl}/mcp`, name: 'Fake UBC', scopes: ['mcp:tools'] },
            { resource: `${resourceUrl}/rogue`, name: 'Rogue' },
            {
              resource: `${resourceUrl}/restricted`,
              name: 'Restricted',
              allowedClients: ['somebody-else'],
            },
          ],
        },
      },
    }),
  );
  hub = await startHub(settingsPath, []);
}, 60000);

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  await hub?.stop();
  await new Promise<void>((resolve) => resourceServer.close(() => resolve()));
  fetchSpy.mockRestore();
  fs.rmSync(directory, { recursive: true, force: true });
  delete process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.USE_DB;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const call = (client: Client) =>
  client.callTool({ name: 'ubc-whoami', arguments: {} }) as Promise<any>;
const subOf = (result: any) => JSON.parse(result.content[0].text).sub as string;
const statusOf = (result: any) => result?._meta?.['mcphub/status'];
const serverView = async (user: string) =>
  (await hub.api('get', '/api/workspace/servers', user)).body.data.find(
    (s: any) => s.name === 'ubc',
  );
const open = async (user: 'alice' | 'bob') => {
  const client = await hub.connect(user, bearer(`${user}-laptop`));
  clients.push(client);
  return client;
};

// The part of the flow the user's browser performs.
const authorizeInBrowser = async (user: string, authorizationUrl: string) => {
  const url = new URL(authorizationUrl);
  expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/oauth/authorize`);
  const query = url.searchParams;
  expect(query.get('resource')).toBe(`${resourceUrl}/mcp`);
  expect(query.get('client_id')).toBe(SELF_CLIENT);
  // The scope comes from the service's metadata; the entry lists it, so it is granted.
  expect(query.get('scope')).toBe('mcp:tools');
  expect(query.get('code_challenge_method')).toBe('S256');
  expect(query.get('redirect_uri')).toBe(`${ISSUER}/oauth/callback`);
  // The consent screen names the external resource.
  const consent = await hub.api('get', `/oauth/authorize${url.search}`, user);
  expect(consent.status).toBe(200);
  expect(consent.text).toContain('Fake UBC');
  const approval = await hub
    .api('post', '/oauth/authorize', user)
    .type('form')
    .set('accept', 'application/json')
    .send({
      allow: 'true',
      client_id: query.get('client_id'),
      redirect_uri: query.get('redirect_uri'),
      response_type: 'code',
      scope: query.get('scope') ?? '',
      state: query.get('state'),
      resource: query.get('resource'),
      code_challenge: query.get('code_challenge'),
      code_challenge_method: 'S256',
    });
  expect(approval.status).toBe(200);
  const redirect = new URL(approval.body.redirect);
  expect(`${redirect.origin}${redirect.pathname}`).toBe(`${ISSUER}/oauth/callback`);
  expect(redirect.searchParams.get('state')).toBe(query.get('state'));
  // The redirect lands on the hub; the unreachable public host is replaced by the listener.
  return fetch(`${hub.baseUrl}${redirect.pathname}${redirect.search}`);
};

const connectUser = async (user: 'alice' | 'bob') => {
  expect(
    (await hub.api('put', '/api/workspace/servers/ubc/selection', user, { selected: true })).status,
  ).toBe(200);
  const start = await hub.api('post', '/api/servers/ubc/oauth/personal', user, {});
  expect(start.status).toBe(200);
  expect(start.body.data.status).toBe('oauth_required');
  const callback = await authorizeInBrowser(user, start.body.data.authorizationUrl);
  expect(callback.status).toBe(200);
};

describe('a server that is an external resource of this hub', () => {
  it('1. needs_auth before connecting, with the connect action and no call reaching the upstream', async () => {
    expect(
      (await hub.api('put', '/api/workspace/servers/ubc/selection', 'alice', { selected: true }))
        .status,
    ).toBe(200);
    const alice = await open('alice');
    expect((await serverView('alice')).status).toMatchObject({
      code: 'needs_auth',
      action: 'connect',
    });
    const blocked = await call(alice);
    expect(blocked.isError).toBe(true);
    expect(statusOf(blocked)).toMatchObject({
      server: 'ubc',
      code: 'needs_auth',
      action: 'connect',
    });
    expect(seen).toEqual([]);
  });

  it('2. connect registers the public client, binds the resource and each user gets their own sub', async () => {
    await connectUser('alice');
    await connectUser('bob');

    // The client was registered without any administrator step, public and callback-only.
    const clientsInStore = readSettings(settingsPath).oauthClients as Array<Record<string, any>>;
    const self = clientsInStore.find((c) => c.clientId === SELF_CLIENT)!;
    expect(self.clientSecret).toBeUndefined();
    expect(self.redirectUris).toEqual([`${ISSUER}/oauth/callback`]);

    // Nothing was ever sent to the (unreachable) public URL.
    expect(publicUrlFetches).toEqual([]);

    // Code exchange: resource repeated, public client, PKCE verifier, own token endpoint.
    expect(tokenRequests).toHaveLength(2);
    for (const request of tokenRequests) {
      expect(request.get('grant_type')).toBe('authorization_code');
      expect(request.get('resource')).toBe(`${resourceUrl}/mcp`);
      expect(request.get('client_id')).toBe(SELF_CLIENT);
      expect(request.get('client_secret')).toBeNull();
      expect(request.get('code_verifier')).toBeTruthy();
    }
    expect(tokenRequests[0].get('code_verifier')).not.toBe(tokenRequests[1].get('code_verifier'));

    const alice = await open('alice');
    const bob = await open('bob');
    expect((await serverView('alice')).status.code).toBe('available');
    const [a, b] = await Promise.all([call(alice), call(bob)]);
    expect(a.isError).toBeFalsy();
    expect(subOf(a)).toBe('alice');
    expect(subOf(b)).toBe('bob');
    for (const entry of seen) {
      expect(entry.aud).toBe(`${resourceUrl}/mcp`);
      expect(entry.clientId).toBe(SELF_CLIENT);
      expect(entry.scope).toBe('mcp:tools');
    }

    // The grant is stored encrypted, per user; no token reaches the settings files in the clear.
    const sidecar = fs.readFileSync(`${settingsPath}.credentials.json`, 'utf8');
    for (const entry of seen) expect(sidecar).not.toContain(entry.token);
    expect(sidecar).not.toMatch(/refresh_token|"accessToken"/);

    // Connected clients (M3) lists it as the public client with the resource's name.
    const listed = (await hub.api('get', '/api/workspace/clients', 'alice')).body.data as any[];
    const entry = listed.find((c) => c.id === SELF_CLIENT);
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).toContain('Fake UBC');
  });

  it('3. an expired access token is refreshed for the same audience and the same user', async () => {
    const alice = await open('alice');
    const before = seen.filter((e) => e.sub === 'alice').at(-1)!;
    const requestsBefore = tokenRequests.length;
    await sleep((LIFETIME_SECONDS + 1) * 1000);
    const rejectedBefore = rejected;
    const result = await call(alice);
    expect(result.isError).toBeFalsy();
    expect(subOf(result)).toBe('alice');
    const after = seen.filter((e) => e.sub === 'alice').at(-1)!;
    expect(after.token).not.toBe(before.token);
    expect(after.aud).toBe(before.aud);
    expect(rejected).toBeGreaterThan(rejectedBefore);
    const refreshes = tokenRequests.slice(requestsBefore);
    expect(refreshes.length).toBeGreaterThanOrEqual(1);
    for (const request of refreshes) {
      expect(request.get('grant_type')).toBe('refresh_token');
      expect(request.get('resource')).toBe(`${resourceUrl}/mcp`);
      expect(request.get('client_id')).toBe(SELF_CLIENT);
    }
    expect(tokenResponses.every((status) => status === 200)).toBe(true);
    // Bob's grant is untouched by alice's refresh.
    const bob = await open('bob');
    expect(subOf(await call(bob))).toBe('bob');
  }, 30000);

  it("4. revoking a connected client (M3) stops that user's refresh; the other user is unaffected", async () => {
    const bob = await open('bob');
    expect(subOf(await call(bob))).toBe('bob');
    const revoked = await hub.api('delete', `/api/workspace/clients/oauth/${SELF_CLIENT}`, 'bob');
    expect(revoked.status).toBe(200);
    await sleep((LIFETIME_SECONDS + 1) * 1000);
    const callsBefore = seen.filter((e) => e.sub === 'bob').length;
    const result = await call(bob);
    expect(result.isError).toBe(true);
    expect(seen.filter((e) => e.sub === 'bob')).toHaveLength(callsBefore);
    expect(tokenResponses.at(-1)).toBe(400);
    // Alice still works.
    expect(subOf(await call(await open('alice')))).toBe('alice');
  }, 30000);

  it('5. disconnecting personal OAuth ends the grant here too: revoked, and no further refresh', async () => {
    const alice = await open('alice');
    expect(subOf(await call(alice))).toBe('alice');
    const disconnect = await hub.api('delete', '/api/servers/ubc/oauth/personal', 'alice');
    expect(disconnect.status).toBe(200);
    // The grant on the authorization server is gone, not only the stored copy.
    const listed = (await hub.api('get', '/api/workspace/clients', 'alice')).body.data as any[];
    expect(listed.find((c) => c.id === SELF_CLIENT)).toBeUndefined();
    expect((await serverView('alice')).status.code).toBe('revoked');
    await sleep((LIFETIME_SECONDS + 1) * 1000);
    const requests = tokenRequests.length;
    const callsBefore = seen.filter((e) => e.sub === 'alice').length;
    const result = await call(alice);
    expect(result.isError).toBe(true);
    expect(statusOf(result)).toMatchObject({ server: 'ubc', code: 'revoked' });
    expect(tokenRequests).toHaveLength(requests);
    expect(seen.filter((e) => e.sub === 'alice')).toHaveLength(callsBefore);
  }, 30000);

  it('6. a second connect after a disconnect works from scratch', async () => {
    await connectUser('alice');
    const alice = await open('alice');
    expect(subOf(await call(alice))).toBe('alice');
    expect((await serverView('alice')).status.code).toBe('available');
  }, 30000);

  it("7. a server's own redirect overrides never reach the shared client; an unregistered redirect_uri is refused", async () => {
    const before = (readSettings(settingsPath).oauthClients as any[]).find(
      (c) => c.clientId === SELF_CLIENT,
    ).redirectUris;
    const start = await hub.api('post', '/api/servers/ubc-redirect/oauth/personal', 'bob', {});
    expect(start.status).toBe(200);
    const url = new URL(start.body.data.authorizationUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(`${ISSUER}/oauth/callback`);
    const after = (readSettings(settingsPath).oauthClients as any[]).find(
      (c) => c.clientId === SELF_CLIENT,
    ).redirectUris;
    expect(after).toEqual(before);
    expect(after).toEqual([`${ISSUER}/oauth/callback`]);
    for (const evil of ['https://evil.example/cb', 'https://evil.example/cb2']) {
      const query = new URLSearchParams(url.search);
      query.set('redirect_uri', evil);
      const refused = await hub.api('get', `/oauth/authorize?${query}`, 'bob');
      expect(refused.status).toBe(400);
      expect(JSON.stringify(refused.body)).toContain('redirect_uri');
    }
  });

  it('8. an upstream that names another authorization server is refused: no authorization URL', async () => {
    const start = await hub.api('post', '/api/servers/wrong-as/oauth/personal', 'bob', {});
    expect(start.status).not.toBe(200);
    expect(start.body.data?.authorizationUrl).toBeUndefined();
  });

  it('9. an allowedClients list without the public client is refused with an administrator-facing message', async () => {
    const start = await hub.api('post', '/api/servers/restricted/oauth/personal', 'bob', {});
    expect(start.status).toBe(400);
    expect(start.body.message).toContain('allowedClients');
    expect(start.body.message).toContain(SELF_CLIENT);
  });

  it('10. the public client id cannot be borrowed: refused when saving and when connecting', async () => {
    const config = {
      type: 'streamable-http',
      url: `${resourceUrl}/not-listed`,
      visibility: 'public',
      oauth: { identityMode: 'personal', clientId: SELF_CLIENT },
    };
    const created = await hub.api('post', '/api/servers', 'admin', { name: 'new', config });
    expect(created.status).toBe(400);
    expect(created.body.message).toContain('reserved');
    const updated = await hub.api('put', '/api/servers/wrong-as', 'admin', {
      config: { ...config, url: `${resourceUrl}/rogue`, oauth: { ...config.oauth } },
    });
    expect(updated.status).toBe(200);
    const borrowed = await hub.api('put', '/api/servers/wrong-as', 'admin', { config });
    expect(borrowed.status).toBe(400);
    expect(borrowed.body.message).toContain('reserved');
    const connect = await hub.api('post', '/api/servers/borrow/oauth/personal', 'bob', {});
    expect(connect.status).toBe(400);
    expect(connect.body.message).toContain('reserved');
  });
});
