import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { auth, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { LegacyMcpClient } from '../../src/clients/legacyMcpClient.js';
import { MCPHubOAuthProvider } from '../../src/services/mcpOAuthProvider.js';
import { createOAuthFetch } from '../../src/services/oauthClientRegistration.js';
import {
  PersonalOAuthContext,
  personalOAuthContexts,
  findPersonalOAuthFlow,
  disconnectPersonalOAuth,
} from '../../src/services/personalOAuthService.js';
import { CredentialBindingDaoImpl } from '../../src/dao/CredentialBindingDao.js';
import { getServerDao } from '../../src/dao/index.js';
import { logger } from '../../src/utils/logger.js';
import { normalizeServerConfigForPersistence } from '../../src/utils/serverConfigPersistence.js';
import type { ServerConfigWithName } from '../../src/types/index.js';

jest.mock('../../src/dao/index.js', () => ({ getServerDao: jest.fn() }));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getCredentialBindingDao: () =>
    new (jest.requireActual('../../src/dao/CredentialBindingDao.js').CredentialBindingDaoImpl)(),
  getServerDao: () => ({
    findById: async () => mockDefinition,
    findAll: async () => [mockDefinition],
  }),
  getUserDao: () => ({
    findByUsername: async (username: string) => ({ username, isAdmin: false }),
  }),
}));
jest.mock('../../src/services/mcpService.js', () => ({ getServerByName: jest.fn() }));
jest.mock('../../src/services/oauthClientRegistration.js', () => ({
  getRegisteredClient: jest.fn(),
  removeRegisteredClient: jest.fn(),
  createOAuthFetch: jest.fn(async () => fetchFn),
}));
const discoveredIssuer = 'http://gitlab.internal.example';
let issuer = discoveredIssuer;
let requestedUrls: string[];
const mockDefinition: ServerConfigWithName = {
  name: 'gitlab',
  type: 'streamable-http',
  url: 'https://gitlab.example/mcp',
  visibility: 'public',
  oauth: {
    identityMode: 'personal',
    allowInsecureTokenEndpoint: true,
    clientId: 'client',
    scopes: ['mcp'],
  },
};
let tokenRequests: URLSearchParams[];
const fetchFn: typeof fetch = async (input, init) => {
  const url = String(input);
  requestedUrls.push(url);
  if (url === `${issuer}/token`) {
    const body = new URLSearchParams(String(init?.body));
    tokenRequests.push(body);
    const identity =
      body.get('code') || body.get('refresh_token')?.replace('refresh-', '') || 'unknown';
    return Response.json({
      access_token: `token-${identity}`,
      refresh_token: `refresh-${identity}`,
      token_type: 'Bearer',
    });
  }
  if (url.includes('oauth-protected-resource'))
    return Response.json({
      resource: mockDefinition.url,
      authorization_servers: [discoveredIssuer],
    });
  return Response.json({
    issuer: discoveredIssuer,
    authorization_endpoint: `${discoveredIssuer}/authorize`,
    token_endpoint: `${discoveredIssuer}/token`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  });
};
let directory: string;
const originalEnv = {
  path: process.env.MCPHUB_SETTING_PATH,
  key: process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY,
};
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-oauth-sdk-'));
  process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  tokenRequests = [];
  requestedUrls = [];
  jest.mocked(createOAuthFetch).mockResolvedValue(fetchFn);
  issuer = discoveredIssuer;
  delete mockDefinition.oauth!.authorizationServerMetadata;
  delete mockDefinition.oauth!.clientSecret;
  jest.mocked(getServerDao).mockReturnValue({ findById: async () => mockDefinition } as any);
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
  if (originalEnv.path === undefined) delete process.env.MCPHUB_SETTING_PATH;
  else process.env.MCPHUB_SETTING_PATH = originalEnv.path;
  if (originalEnv.key === undefined) delete process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
  else process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = originalEnv.key;
});
const provider = async (username: string) => {
  const context = await PersonalOAuthContext.load('gitlab', username, mockDefinition);
  return { context, provider: new MCPHubOAuthProvider('gitlab', context.config) };
};

test('#1432 persists absolute expiry and saves expiry-only changes', async () => {
  const a = await provider('alice');
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now);
  const save = jest.spyOn(a.context, 'persistTokens');
  const tokens = {
    access_token: 'opaque-alice',
    refresh_token: 'refresh-alice',
    token_type: 'Bearer',
    expires_in: 1,
  };
  await a.provider.saveTokens(tokens);
  expect(save).toHaveBeenCalledTimes(1);
  expect(save.mock.calls[0][1]).toEqual({
    accessToken: 'opaque-alice',
    accessTokenExpiresAt: now + 1000,
    refreshToken: 'refresh-alice',
    clearPendingAuthorization: false,
  });
  await a.provider.saveTokens({ ...tokens, expires_in: 3600 });
  expect(save).toHaveBeenCalledTimes(2);
  jest.spyOn(Date, 'now').mockReturnValue(now + 1100);
  const restarted = await provider('alice');
  expect(await restarted.provider.tokens()).toEqual({
    access_token: 'opaque-alice',
    refresh_token: 'refresh-alice',
    token_type: 'Bearer',
    expires_in: 3598,
  });
  expect(restarted.context.config.oauth.accessTokenExpiresAt).toBe(now + 3600_000);
});

test('#1432 concurrent providers share renewal, persist rotation, and isolate users', async () => {
  for (const username of ['alice', 'bob']) {
    const a = await provider(username);
    await a.provider.saveTokens({
      access_token: `old-${username}`,
      refresh_token: `refresh-${username}`,
      token_type: 'Bearer',
      expires_in: 0,
    });
  }
  jest.mocked(createOAuthFetch).mockResolvedValue(async (input, init) => {
    if (!String(input).endsWith('/token')) return fetchFn(input, init);
    const body = new URLSearchParams(String(init?.body));
    tokenRequests.push(body);
    const user = body.get('refresh_token')!.replace('refresh-', '');
    return Response.json({
      access_token: `new-${user}`,
      refresh_token: `rotated-${user}`,
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });
  const [a, b, other] = await Promise.all([provider('alice'), provider('alice'), provider('bob')]);
  const [first, second, third] = await Promise.all([
    a.provider.tokens(),
    b.provider.tokens(),
    other.provider.tokens(),
  ]);
  expect(first?.access_token).toBe('new-alice');
  expect(second).toEqual(first);
  expect(third?.access_token).toBe('new-bob');
  expect(tokenRequests.map((body) => body.get('refresh_token')).sort()).toEqual([
    'refresh-alice',
    'refresh-bob',
  ]);
  expect((await provider('alice')).context.config.oauth.refreshToken).toBe('rotated-alice');
  expect((await provider('bob')).context.config.oauth.refreshToken).toBe('rotated-bob');
  await Promise.all([a.provider.tokens(), b.provider.tokens()]);
  expect(tokenRequests).toHaveLength(2);
});

test('#1432 disconnect during renewal rejects late persistence', async () => {
  const a = await provider('alice');
  await a.provider.saveTokens({
    access_token: 'old',
    refresh_token: 'refresh-alice',
    token_type: 'Bearer',
    expires_in: 0,
  });
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  jest.mocked(createOAuthFetch).mockResolvedValue(async (input, init) => {
    if (!String(input).endsWith('/token')) return fetchFn(input, init);
    started();
    await gate;
    return Response.json({
      access_token: 'late',
      refresh_token: 'rotated',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  });
  const renewal = a.provider.tokens();
  const rejected = expect(renewal).rejects.toThrow('changed');
  await requested;
  await disconnectPersonalOAuth('gitlab', 'alice');
  release();
  await rejected;
  expect(await await (await provider('alice')).provider.tokens()).toBeUndefined();
});

test('#1432 clears stale expiry on replacement and disconnect, preserving an omitted refresh token', async () => {
  const a = await provider('alice');
  await a.provider.saveTokens({
    access_token: 'old',
    refresh_token: 'refresh-alice',
    token_type: 'Bearer',
    expires_in: 3600,
  });
  await a.provider.saveTokens({ access_token: 'replacement', token_type: 'Bearer' });
  const restored = await provider('alice');
  expect(await restored.provider.tokens()).toEqual({
    access_token: 'replacement',
    refresh_token: 'refresh-alice',
    token_type: 'Bearer',
  });
  expect(restored.context.config.oauth.accessTokenExpiresAt).toBeUndefined();
  await a.context.clearOAuthData('gitlab', 'tokens');
  expect((await provider('alice')).context.config.oauth.accessTokenExpiresAt).toBeUndefined();
});

test.each([-1, Infinity, NaN])('#1432 rejects invalid expires_in=%s', async (expires_in) => {
  const a = await provider('alice');
  await expect(
    a.provider.saveTokens({ access_token: 'invalid', token_type: 'Bearer', expires_in }),
  ).rejects.toThrow('expiry');
  expect(await await (await provider('alice')).provider.tokens()).toBeUndefined();
});

test('#1432 an expired token without a refresh grant is never returned', async () => {
  const a = await provider('alice');
  await a.provider.saveTokens({ access_token: 'expired', token_type: 'Bearer', expires_in: 0 });
  await expect(a.provider.tokens()).rejects.toThrow('expired');
  expect(tokenRequests).toHaveLength(0);
});

test('#1432 a failed renewal rejects concurrent callers and permits a later retry', async () => {
  const a = await provider('alice');
  await a.provider.saveTokens({
    access_token: 'old',
    refresh_token: 'refresh-alice',
    token_type: 'Bearer',
    expires_in: 0,
  });
  jest.mocked(createOAuthFetch).mockRejectedValueOnce(new Error('token endpoint unavailable'));
  const results = await Promise.allSettled([a.provider.tokens(), a.provider.tokens()]);
  expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(tokenRequests).toHaveLength(0);
  expect((await a.provider.tokens())?.access_token).toBe('token-alice');
  expect(tokenRequests).toHaveLength(1);
});

test.each([true, false])(
  '#1432 renews expired tokens before use; early revocation is not replayed (expired=%s)',
  async (expired) => {
    const a = await provider('alice');
    await a.provider.saveTokens({
      access_token: 'opaque-alice',
      refresh_token: 'refresh-alice',
      token_type: 'Bearer',
      expires_in: expired ? 0 : 3600,
    });
    const restarted = await provider('alice');
    const graphError = {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 401,
            error: { code: 'InvalidAuthenticationToken', message: 'Access token rejected' },
          }),
        },
      ],
    };
    const headers: string[] = [];
    const upstream: typeof fetch = async (input, init) => {
      if (String(input) !== mockDefinition.url) return fetchFn(input, init);
      const message = JSON.parse(String(init?.body));
      headers.push(new Headers(init?.headers).get('authorization') || '');
      if (message.method === 'notifications/initialized')
        return new Response(null, { status: 202 });
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'mock-graph', version: '1' },
            }
          : message.method === 'tools/list'
            ? { tools: [{ name: 'profile', inputSchema: { type: 'object' } }] }
            : new Headers(init?.headers).get('authorization') === 'Bearer token-alice'
              ? { content: [{ type: 'text', text: 'profile restored' }] }
              : graphError;
      return Response.json({ jsonrpc: '2.0', id: message.id, result });
    };
    const transport = new StreamableHTTPClientTransport(new URL(mockDefinition.url!), {
      authProvider: restarted.provider,
      fetch: restarted.context.wrapFetch(upstream),
    });
    const client = new LegacyMcpClient({ name: 'expiry-reproduction', version: '1' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools).toHaveLength(1);
      if (expired) {
        expect(headers.every((header) => header === 'Bearer token-alice')).toBe(true);
      } else {
        for (let attempt = 0; attempt < 2; attempt++)
          expect(await client.callTool({ name: 'profile', arguments: {} })).toEqual(graphError);
        expect(tokenRequests).toHaveLength(0);
        expect(headers.every((header) => header === 'Bearer opaque-alice')).toBe(true);
        await expect(
          auth(restarted.provider, {
            serverUrl: mockDefinition.url!,
            fetchFn: restarted.context.wrapFetch(upstream),
          }),
        ).resolves.toBe('AUTHORIZED');
      }
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0].get('refresh_token')).toBe('refresh-alice');
      expect((await await (await provider('alice')).provider.tokens())?.access_token).toBe(
        'token-alice',
      );
      expect(await client.callTool({ name: 'profile', arguments: {} })).toEqual({
        content: [{ type: 'text', text: 'profile restored' }],
      });
    } finally {
      await client.close();
    }
  },
);

test.each([false, true])(
  'two SDK flows isolate PKCE, exchange and refresh with metadata override=%s',
  async (override) => {
    if (override) {
      issuer = 'https://login.example.com/tenant/v2.0';
      mockDefinition.oauth!.clientSecret = 'static-secret';
      mockDefinition.oauth!.authorizationServerMetadata = {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post'],
        authorization_response_iss_parameter_supported: true,
      };
    }
    const a = await provider('alice');
    const b = await provider('bob');
    await Promise.all(
      [a, b].map((p) =>
        expect(auth(p.provider, { serverUrl: mockDefinition.url!, fetchFn })).rejects.toThrow(
          'OAuth authorization required',
        ),
      ),
    );
    const aPending = a.context.config.oauth.pendingAuthorization!;
    const bPending = b.context.config.oauth.pendingAuthorization!;
    const authorizationUrl = new URL(aPending.authorizationUrl!);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${issuer}/authorize`);
    expect(authorizationUrl.searchParams.get('resource')).toBe(mockDefinition.url);
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(aPending.issuer).toBe(issuer);
    expect(aPending.state).not.toBe(bPending.state);
    expect(aPending.codeVerifier).not.toBe(bPending.codeVerifier);
    expect((await findPersonalOAuthFlow(aPending.state!))?.username).toBe('alice');
    expect(JSON.stringify(jest.mocked(logger.log).mock.calls)).not.toContain(
      aPending.authorizationUrl,
    );
    const restartedA = await provider('alice');
    for (const [user, p] of [
      ['alice', restartedA],
      ['bob', b],
    ] as const) {
      await new StreamableHTTPClientTransport(new URL(mockDefinition.url!), {
        authProvider: p.provider,
        fetch: fetchFn,
      }).finishAuth(user, override ? issuer : undefined);
      expect((await p.provider.tokens())?.access_token).toBe(`token-${user}`);
    }
    expect(tokenRequests[0].get('code_verifier')).toBe(aPending.codeVerifier);
    expect(tokenRequests[1].get('code_verifier')).toBe(bPending.codeVerifier);
    expect(await findPersonalOAuthFlow(aPending.state!)).toBeUndefined();
    await expect(
      auth(restartedA.provider, { serverUrl: mockDefinition.url!, fetchFn }),
    ).resolves.toBe('AUTHORIZED');
    expect(tokenRequests[2].get('refresh_token')).toBe('refresh-alice');
    for (const request of tokenRequests) {
      expect(request.get('resource')).toBe(mockDefinition.url);
      if (override) expect(request.get('client_secret')).toBe('static-secret');
    }
    if (override) {
      expect(requestedUrls.filter((url) => url.includes('oauth-authorization-server'))).toEqual([]);
      expect(requestedUrls.filter((url) => url.endsWith('/token'))).toEqual(
        Array(3).fill(`${issuer}/token`),
      );
    }
    expect((await (await provider('bob')).provider.tokens())?.access_token).toBe('token-bob');
    expect(mockDefinition.oauth).not.toHaveProperty('accessToken');
    const persisted = fs.readFileSync(
      `${process.env.MCPHUB_SETTING_PATH}.credentials.json`,
      'utf8',
    );
    expect(persisted).not.toMatch(/token-alice|refresh-bob|codeVerifier/);
  },
);

test('disconnection rejects a late SDK token save and never restores the old binding', async () => {
  const a = await provider('alice');
  await a.provider.saveTokens({ access_token: 'old', token_type: 'Bearer' });
  await disconnectPersonalOAuth('gitlab', 'alice');
  await expect(
    a.provider.saveTokens({ access_token: 'late', token_type: 'Bearer' }),
  ).rejects.toThrow('changed');
  expect(await (await provider('alice')).provider.tokens()).toBeUndefined();
});

test('coalesces concurrent refresh requests for the same user binding', async () => {
  const a = await provider('alice');
  await a.provider.saveTokens({
    access_token: 'old',
    refresh_token: 'refresh-alice',
    token_type: 'Bearer',
  });
  const wrapped = a.context.wrapFetch(fetchFn);
  await Promise.all(
    [1, 2].map(() => auth(a.provider, { serverUrl: mockDefinition.url!, fetchFn: wrapped })),
  );
  expect(tokenRequests).toHaveLength(1);
  expect((await (await provider('alice')).provider.tokens())?.access_token).toBe('token-alice');
});

test('a failed refresh response does not poison subsequent refresh attempts', async () => {
  const a = await provider('alice');
  let calls = 0;
  const wrapped = a.context.wrapFetch(async () => {
    calls++;
    return new Response('', { status: calls === 1 ? 503 : 200 });
  });
  const request = {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'same-token' }),
  };
  expect((await wrapped(`${issuer}/token`, request)).status).toBe(503);
  expect((await wrapped(`${issuer}/token`, request)).status).toBe(200);
});

test('an active personal OAuth flow survives normalization of the default SSE type', async () => {
  const originalType = mockDefinition.type;
  try {
    delete mockDefinition.type;
    const a = await provider('alice');
    await a.provider.saveTokens({
      access_token: 'old',
      refresh_token: 'refresh-alice',
      token_type: 'Bearer',
    });
    Object.assign(mockDefinition, normalizeServerConfigForPersistence(mockDefinition));
    expect(mockDefinition.type).toBe('sse');
    await expect(auth(a.provider, { serverUrl: mockDefinition.url!, fetchFn })).resolves.toBe(
      'AUTHORIZED',
    );
    expect((await (await provider('alice')).provider.tokens())?.access_token).toBe('token-alice');
    expect(tokenRequests[0].get('refresh_token')).toBe('refresh-alice');
    mockDefinition.type = 'streamable-http';
    await expect(
      a.provider.saveTokens({ access_token: 'late', token_type: 'Bearer' }),
    ).rejects.toThrow('changed');
    expect(await (await provider('alice')).provider.tokens()).toBeUndefined();
  } finally {
    mockDefinition.type = originalType;
  }
});

test('explicit metadata preserves callback issuer validation before token exchange', async () => {
  mockDefinition.oauth!.authorizationServerMetadata = {
    issuer: 'https://login.example.com/tenant',
    authorization_endpoint: 'https://login.example.com/authorize',
    token_endpoint: 'https://login.example.com/token',
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
  };
  const a = await provider('alice');
  await expect(auth(a.provider, { serverUrl: mockDefinition.url!, fetchFn })).rejects.toThrow(
    'OAuth authorization required',
  );
  const restarted = await provider('alice');
  const transport = new StreamableHTTPClientTransport(new URL(mockDefinition.url!), {
    authProvider: restarted.provider,
    fetch: fetchFn,
  });
  await expect(transport.finishAuth('alice')).rejects.toThrow(/iss/i);
  await expect(transport.finishAuth('alice', 'https://wrong.example.com')).rejects.toThrow(/iss/i);
  expect(tokenRequests).toHaveLength(0);
  expect(requestedUrls.some((url) => url.endsWith('/token'))).toBe(false);
});

test('explicit metadata does not bypass MCP resource validation', async () => {
  mockDefinition.oauth!.authorizationServerMetadata = {
    issuer: 'https://login.example.com',
    authorization_endpoint: 'https://login.example.com/authorize',
    token_endpoint: 'https://login.example.com/token',
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
  };
  const a = await provider('alice');
  await expect(
    auth(a.provider, {
      serverUrl: mockDefinition.url!,
      fetchFn: async () => Response.json({ resource: 'https://unrelated.example/mcp' }),
    }),
  ).rejects.toThrow('does not match expected');
  expect(tokenRequests).toHaveLength(0);
});

test('#1432 invalid_grant clears rejected credentials and prepares authorization', async () => {
  const a = await provider('alice');
  await a.provider.saveTokens({
    access_token: 'expired',
    refresh_token: 'rejected',
    token_type: 'Bearer',
    expires_in: 0,
  });
  let refreshes = 0;
  jest.mocked(createOAuthFetch).mockResolvedValue(async (input, init) => {
    if (!String(input).endsWith('/token')) return fetchFn(input, init);
    refreshes++;
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  });
  await expect(a.provider.tokens()).rejects.toThrow();
  expect(refreshes).toBe(1);
  expect(await a.provider.tokens()).toBeUndefined();
  const restored = await provider('alice');
  expect(await restored.provider.tokens()).toBeUndefined();
  expect(restored.context.config.oauth.refreshToken).toBeUndefined();
  expect(restored.context.authorizationUrl).toBeDefined();
});
