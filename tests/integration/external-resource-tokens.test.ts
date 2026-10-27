import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import type { IUser, IOAuthToken } from '../../src/types/index.js';

let users: IUser[];
let tokens: IOAuthToken[];
let oauthServerConfig: Record<string, unknown>;
const ISSUER = 'https://hub.example.com';
const UBC = 'https://ubc.example/mcp';
const OTHER = 'https://other.example/mcp';
const OWN = `${ISSUER}/mcp/team`;
const clients: Record<string, Record<string, unknown>> = {
  'ubc-pub': {
    clientId: 'ubc-pub',
    name: 'UBC Connector',
    redirectUris: ['https://ubc.example/cb'],
    grants: ['authorization_code', 'refresh_token'],
  },
  'rogue-pub': {
    clientId: 'rogue-pub',
    name: 'Rogue App',
    redirectUris: ['https://ubc.example/cb'],
    grants: ['authorization_code', 'refresh_token'],
  },
};
let installBaseUrl: string | undefined;
const systemConfig = () => ({
  ...(installBaseUrl ? { install: { baseUrl: installBaseUrl } } : {}),
  oauthServer: oauthServerConfig,
});

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => ({
    findAll: async () => users,
    findByUsername: async (username: string) => users.find((user) => user.username === username),
  }),
  getBearerKeyDao: () => ({ findEnabled: async () => [], findByOwner: async () => [] }),
  getOAuthClientDao: () => ({ findByClientId: async (id: string) => clients[id] }),
  getOAuthTokenDao: () => ({
    findByAccessToken: async (value: string) => tokens.find((token) => token.accessToken === value),
    findByRefreshToken: async (value: string) =>
      tokens.find((token) => token.refreshToken === value),
    findByUsername: async (username: string) => tokens.filter((t) => t.username === username),
    create: async (token: IOAuthToken) => {
      tokens.push(token);
      return token;
    },
    revokeToken: async (value: string) => {
      tokens = tokens.filter((t) => t.accessToken !== value && t.refreshToken !== value);
      return true;
    },
    revokeUserTokens: async () => 0,
  }),
  getGroupDao: () => ({ findAll: async () => [], findByName: async () => null }),
  getServerDao: () => ({ findById: async () => null, findAll: async () => [] }),
  getSystemConfigDao: () => ({ get: async () => systemConfig() }),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getSystemConfigDao: () => ({ get: async () => systemConfig() }),
  getServerDao: () => ({ findById: async () => null, findAll: async () => [] }),
  getCredentialBindingDao: () => ({ hasBindings: async () => false }),
  getUserDao: () => ({
    findByUsername: async (username: string) => users.find((user) => user.username === username),
  }),
}));
jest.mock('../../src/services/betterAuthConfig.js', () => ({
  getBetterAuthRuntimeConfig: async () => ({ enabled: false }),
}));
jest.mock('../../src/services/betterAuthSession.js', () => ({
  resolveBetterAuthUser: async () => null,
}));
jest.mock('../../src/services/forwardAuthService.js', () => ({
  authenticateForwardAuthToken: async () => ({ status: 'unhandled' }),
}));
jest.mock('../../src/utils/frontendShell.js', () => ({
  injectOAuthConsentShell: jest.fn(
    (context: unknown) => `<html><script>${JSON.stringify(context)}</script></html>`,
  ),
}));

import { JWT_SECRET } from '../../src/config/jwt.js';
import { auth } from '../../src/middlewares/auth.js';
import {
  getAuthorize,
  getJwks,
  getMetadata,
  getUserInfo,
  postAuthorize,
  postToken,
  rotateOAuthSigningKey,
} from '../../src/controllers/oauthServerController.js';
import { generateCodeChallenge, initOAuthServer } from '../../src/services/oauthServerService.js';
import { resetSigningKeyCache } from '../../src/services/oauthSigningKeyService.js';
import {
  resolveCredentialWriteGrantFromToken,
  resolveOAuthGrantFromToken,
} from '../../src/utils/oauthBearer.js';
import { listConnectedClients } from '../../src/services/connectedClientService.js';
import { injectOAuthConsentShell } from '../../src/utils/frontendShell.js';
import { getUserSessionVersion } from '../../src/utils/userSession.js';

const REDIRECT = 'https://ubc.example/cb';
const verifier = 'v'.repeat(64);
const userJwt = (user: IUser) =>
  jwt.sign(
    {
      user: {
        username: user.username,
        sessionVersion: getUserSessionVersion(user),
        isAdmin: user.isAdmin,
      },
    },
    JWT_SECRET,
  );

let directory: string;
const originalPath = process.env.MCPHUB_SETTING_PATH;
const originalKey = process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
const originalUseDb = process.env.USE_DB;

describe('JWT access tokens for external resources', () => {
  let app: express.Application;
  let aliceJwt: string;
  let adminJwt: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-ext-'));
    process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
    process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    process.env.USE_DB = 'false';
    installBaseUrl = ISSUER;
    jest.restoreAllMocks();
    resetSigningKeyCache();
    oauthServerConfig = {
      enabled: true,
      externalResources: [
        { resource: UBC, name: 'UBC Courses', scopes: ['read'] },
        { resource: OTHER, name: 'Other Service', allowedClients: ['ubc-pub'] },
      ],
    };
    users = [
      { username: 'admin', password: await bcrypt.hash('x', 4), isAdmin: true },
      { username: 'alice', password: await bcrypt.hash('x', 4), isAdmin: false },
    ];
    tokens = [];
    aliceJwt = userJwt(users[1]);
    adminJwt = userJwt(users[0]);
    await initOAuthServer();

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.get('/oauth/authorize', getAuthorize);
    app.post('/oauth/authorize', postAuthorize);
    app.post('/oauth/token', postToken);
    app.get('/oauth/userinfo', getUserInfo);
    app.get('/.well-known/oauth-authorization-server', getMetadata);
    app.get('/.well-known/jwks.json', getJwks);
    app.post('/api/oauth/signing-keys/rotate', auth, rotateOAuthSigningKey);
    app.get('/api/anything', auth, (_req, res) => res.json({ ok: true }));
    app.post('/mcp', async (req, res) => {
      const grant = await resolveOAuthGrantFromToken(req.headers.authorization?.slice(7));
      res.status(grant ? 200 : 401).json({});
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
    if (originalUseDb === undefined) delete process.env.USE_DB;
    else process.env.USE_DB = originalUseDb;
    if (originalPath === undefined) delete process.env.MCPHUB_SETTING_PATH;
    else process.env.MCPHUB_SETTING_PATH = originalPath;
    if (originalKey === undefined) delete process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = originalKey;
  });

  const authorize = (
    resource: string | string[] | undefined,
    { client = 'ubc-pub', scope = 'read' as string | undefined } = {},
  ) =>
    request(app)
      .post('/oauth/authorize')
      .send({
        allow: 'true',
        client_id: client,
        redirect_uri: REDIRECT,
        response_type: 'code',
        ...(scope === undefined ? {} : { scope }),
        ...(resource === undefined ? {} : { resource }),
        token: aliceJwt,
        code_challenge: generateCodeChallenge(verifier),
        code_challenge_method: 'S256',
      });
  const params = (res: request.Response) => new URL(res.headers.location).searchParams;
  const exchange = (code: string, extra: Record<string, string> = {}, client = 'ubc-pub') =>
    request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: client,
        redirect_uri: REDIRECT,
        code,
        code_verifier: verifier,
        ...extra,
      });
  const refresh = (refreshToken: string, extra: Record<string, string> = {}) =>
    request(app)
      .post('/oauth/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: 'ubc-pub',
        refresh_token: refreshToken,
        ...extra,
      });
  // Like an MCP SDK, repeat the resource at the token endpoint (and on refresh) unless told not to.
  const issue = async (
    resource: string | null = UBC,
    scope: string | undefined = 'read',
    repeatAtToken = true,
  ) => {
    const authorization = await authorize(resource ?? undefined, { scope });
    expect(authorization.status).toBe(302);
    const code = params(authorization).get('code');
    expect(code).toBeTruthy();
    const response = await exchange(code!, resource && repeatAtToken ? { resource } : {});
    expect(response.status).toBe(200);
    return response.body as { access_token: string; refresh_token: string; expires_in: number };
  };
  const jwks = async () => (await request(app).get('/.well-known/jwks.json')).body;
  const verify = async (token: string, audience = UBC) =>
    jwtVerify(token, createLocalJWKSet(await jwks()), { issuer: ISSUER, audience });

  describe('metadata and JWKS', () => {
    it('advertises jwks_uri next to the issuer', async () => {
      const metadata = (await request(app).get('/.well-known/oauth-authorization-server')).body;
      expect(metadata.issuer).toBe(ISSUER);
      expect(metadata.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
    });

    it('publishes public ES256 keys only', async () => {
      const response = await request(app).get('/.well-known/jwks.json');
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toContain('max-age');
      expect(response.body.keys).toHaveLength(1);
      const [key] = response.body.keys;
      expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
      expect(key).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig' });
      expect(JSON.stringify(response.body)).not.toMatch(/"d"/);
    });

    it('is empty and creates nothing while no external resource is configured', async () => {
      oauthServerConfig = { enabled: true };
      expect((await jwks()).keys).toEqual([]);
      expect(fs.existsSync(`${process.env.MCPHUB_SETTING_PATH}.oauth-signing-keys.json`)).toBe(
        false,
      );
    });

    it('is not served when the authorization server is disabled', async () => {
      oauthServerConfig = { enabled: false };
      expect((await request(app).get('/.well-known/jwks.json')).status).toBe(404);
    });
  });

  describe('issuing', () => {
    it('issues a verifiable RFC 9068 JWT when the authorization names the resource', async () => {
      const pair = await issue();
      const { payload, protectedHeader } = await verify(pair.access_token);
      expect(protectedHeader).toMatchObject({ alg: 'ES256', typ: 'at+jwt' });
      expect(protectedHeader.kid).toBe((await jwks()).keys[0].kid);
      expect(payload).toMatchObject({
        iss: ISSUER,
        aud: UBC,
        sub: 'alice',
        client_id: 'ubc-pub',
        scope: 'read',
      });
      expect(typeof payload.aud).toBe('string');
      expect(payload.jti).toBeTruthy();
      // Capped at 15 minutes by default, below the 1 hour access token lifetime.
      expect(payload.exp! - payload.iat!).toBe(900);
      expect(pair.expires_in).toBeLessThanOrEqual(900);
      expect(pair.expires_in).toBeGreaterThan(800);
      // The refresh token stays opaque.
      expect(pair.refresh_token).toMatch(/^[0-9a-f]+$/);
    });

    it("grants only the scopes the resource's entry lists and drops the rest", async () => {
      const listed = await issue(UBC, 'read write');
      expect((await verify(listed.access_token)).payload.scope).toBe('read');
      // OTHER lists no scopes: nothing requested is granted, and the request is not refused.
      const unlisted = await issue(OTHER, 'read write');
      const { payload } = await verify(unlisted.access_token, OTHER);
      expect(payload.scope ?? '').toBe('');
    });

    it('never issues an external JWT for a code that was not authorized for that resource', async () => {
      // No resource at authorization: the consent screen never named the service.
      const plain = await authorize(undefined);
      const code = params(plain).get('code')!;
      const refused = await exchange(code, { resource: UBC });
      expect(refused.status).toBe(400);
      expect(refused.body.error).toBe('invalid_target');
      // The code was not spent: the ordinary exchange still works and is opaque.
      const ok = await exchange(code);
      expect(ok.status).toBe(200);
      expect(ok.body.access_token).toMatch(/^[0-9a-f]+$/);

      // A code authorized for one of MCPHub's own routes is no different.
      const own = await authorize(OWN);
      const ownRefused = await exchange(params(own).get('code')!, { resource: UBC });
      expect(ownRefused.body.error).toBe('invalid_target');
    });

    it('accepts a repeated, matching resource at the token endpoint', async () => {
      const authorization = await authorize(UBC);
      const response = await exchange(params(authorization).get('code')!, { resource: UBC });
      expect(response.status).toBe(200);
      expect((await verify(response.body.access_token)).payload.aud).toBe(UBC);
    });

    it('lives for the smaller of the access token lifetime and externalTokenLifetimeSeconds', async () => {
      oauthServerConfig = { ...oauthServerConfig, accessTokenLifetime: 600 };
      let { payload } = await verify((await issue()).access_token);
      expect(payload.exp! - payload.iat!).toBe(600);

      oauthServerConfig = {
        ...oauthServerConfig,
        accessTokenLifetime: 7200,
        externalTokenLifetimeSeconds: 120,
      };
      ({ payload } = await verify((await issue()).access_token));
      expect(payload.exp! - payload.iat!).toBe(120);

      oauthServerConfig = {
        ...oauthServerConfig,
        accessTokenLifetime: 7200,
        externalTokenLifetimeSeconds: 5000,
      };
      ({ payload } = await verify((await issue()).access_token));
      expect(payload.exp! - payload.iat!).toBe(5000);
    });

    it('passes a standard verifier: iss, aud, typ, algorithm and required claims', async () => {
      const { access_token } = await issue();
      const keySet = createLocalJWKSet(await jwks());
      const { payload, protectedHeader } = await jwtVerify(access_token, keySet, {
        issuer: (await request(app).get('/.well-known/oauth-authorization-server')).body.issuer,
        audience: UBC,
        typ: 'at+jwt',
        algorithms: ['ES256'],
        requiredClaims: ['sub', 'exp', 'iat', 'jti', 'client_id', 'scope'],
      });
      expect(protectedHeader.kid).toBeTruthy();
      expect(payload.sub).toBe('alice');
      // Another audience does not verify.
      await expect(
        jwtVerify(access_token, keySet, { issuer: ISSUER, audience: OTHER }),
      ).rejects.toThrow();
    });

    it('refuses to issue without a configured public URL', async () => {
      installBaseUrl = undefined;
      const res = await authorize(UBC);
      expect(params(res).get('error')).toBe('server_error');
      expect(params(res).get('code')).toBeNull();
      expect(tokens).toHaveLength(0);
    });

    it('uses one issuer spelling in metadata, iss and jwks_uri, without a trailing slash', async () => {
      installBaseUrl = `${ISSUER}/`;
      const metadata = (await request(app).get('/.well-known/oauth-authorization-server')).body;
      expect(metadata.issuer).toBe(ISSUER);
      expect(metadata.jwks_uri).toBe(`${ISSUER}/.well-known/jwks.json`);
      expect(metadata.token_endpoint).toBe(`${ISSUER}/oauth/token`);
      const { payload } = await verify((await issue()).access_token);
      expect(payload.iss).toBe(metadata.issuer);
    });

    it("treats a resource on MCPHub's own origin as before: an opaque token", async () => {
      const pair = await issue(OWN);
      expect(pair.access_token).toMatch(/^[0-9a-f]+$/);
      expect(await resolveOAuthGrantFromToken(pair.access_token)).not.toBeNull();
    });

    it("without a configured public URL, an unlisted MCP-shaped URL is treated as MCPHub's own", async () => {
      installBaseUrl = undefined;
      const pair = await issue('https://elsewhere.example/mcp/team');
      expect(pair.access_token).toMatch(/^[0-9a-f]+$/);
      const refused = await authorize('https://elsewhere.example/other');
      expect(params(refused).get('error')).toBe('invalid_target');
    });

    it('keeps MCP SDK behaviour: an own resource repeated at the token and refresh endpoints', async () => {
      // Authorized with resource=OWN, exchanged with resource=OWN.
      const pair = await issue(OWN);
      expect(pair.access_token).toMatch(/^[0-9a-f]+$/);
      expect(await resolveOAuthGrantFromToken(pair.access_token)).not.toBeNull();
      // Refresh of that own grant with resource=OWN.
      const refreshed = await refresh(pair.refresh_token, { resource: OWN });
      expect(refreshed.status).toBe(200);
      expect(refreshed.body.access_token).toMatch(/^[0-9a-f]+$/);
      expect(await resolveOAuthGrantFromToken(refreshed.body.access_token)).not.toBeNull();

      // A code with no resource, exchanged with resource=OWN, and refreshed with it.
      const authorization = await authorize(undefined);
      const exchanged = await exchange(params(authorization).get('code')!, { resource: OWN });
      expect(exchanged.status).toBe(200);
      expect(exchanged.body.access_token).toMatch(/^[0-9a-f]+$/);
      const again = await refresh(exchanged.body.refresh_token, { resource: OWN });
      expect(again.status).toBe(200);
      expect(again.body.access_token).toMatch(/^[0-9a-f]+$/);
    });

    it('refuses an own resource on a grant bound to an external one', async () => {
      const authorization = await authorize(UBC);
      const code = params(authorization).get('code')!;
      expect((await exchange(code, { resource: OWN })).body.error).toBe('invalid_target');
      const pair = (await exchange(code)).body;
      expect((await refresh(pair.refresh_token, { resource: OWN })).body.error).toBe(
        'invalid_target',
      );
      expect((await refresh(pair.refresh_token, { resource: UBC })).status).toBe(200);
    });

    it('issues an opaque token when no resource is named', async () => {
      const pair = await issue(null);
      expect(pair.access_token).toMatch(/^[0-9a-f]+$/);
    });

    it('matches the resource exactly', async () => {
      for (const variant of [
        `${UBC}/`,
        UBC.toUpperCase(),
        `${UBC}?x=1`,
        'http://ubc.example/mcp',
      ]) {
        const res = await authorize(variant);
        expect(params(res).get('error')).toBe('invalid_target');
        expect(params(res).get('code')).toBeNull();
      }
    });
  });

  describe('invalid_target', () => {
    it('refuses an unknown resource at authorization, with state and issuer', async () => {
      const res = await authorize('https://evil.example/mcp');
      expect(res.status).toBe(302);
      expect(params(res).get('error')).toBe('invalid_target');
      expect(params(res).get('iss')).toBe(ISSUER);
      expect(params(res).get('code')).toBeNull();
    });

    it('refuses an unknown resource at the token endpoint', async () => {
      const authorization = await authorize(undefined);
      const response = await exchange(params(authorization).get('code')!, {
        resource: 'https://evil.example/mcp',
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toBe('invalid_target');
    });

    it('refuses a client the resource does not allow, indistinguishably from an unknown one', async () => {
      const denied = await authorize(OTHER, { client: 'rogue-pub' });
      const unknown = await authorize('https://evil.example/mcp', { client: 'rogue-pub' });
      expect(params(denied).get('error')).toBe('invalid_target');
      expect(params(denied).get('error_description')).toBe(
        params(unknown).get('error_description'),
      );
      // The allowed client gets it.
      expect(params(await authorize(OTHER)).get('code')).toBeTruthy();
    });

    it('answers a disallowed client and an unknown resource identically at the token endpoint', async () => {
      const first = await authorize(undefined, { client: 'rogue-pub' });
      const denied = await exchange(params(first).get('code')!, { resource: OTHER }, 'rogue-pub');
      const second = await authorize(undefined, { client: 'rogue-pub' });
      const unknown = await exchange(
        params(second).get('code')!,
        { resource: 'https://evil.example/mcp' },
        'rogue-pub',
      );
      expect(denied.status).toBe(400);
      expect(denied.body).toEqual(unknown.body);
      expect(denied.body.error).toBe('invalid_target');
      expect(tokens).toHaveLength(0);
    });

    it('refuses before spending the code when the client stopped being allowed after consent', async () => {
      const authorization = await authorize(OTHER);
      const code = params(authorization).get('code')!;
      oauthServerConfig = {
        enabled: true,
        externalResources: [{ resource: OTHER, name: 'Other', allowedClients: ['rogue-pub'] }],
      };
      const refused = await exchange(code);
      expect(refused.body.error).toBe('invalid_target');
      // Allowed again: the same code still works.
      oauthServerConfig = {
        enabled: true,
        externalResources: [{ resource: OTHER, name: 'Other', allowedClients: ['ubc-pub'] }],
      };
      expect((await exchange(code)).status).toBe(200);
    });

    it('allows any registered client when allowedClients is empty or absent', async () => {
      oauthServerConfig = {
        enabled: true,
        externalResources: [{ resource: UBC, name: 'UBC', allowedClients: [] }],
      };
      expect(params(await authorize(UBC, { client: 'rogue-pub' })).get('code')).toBeTruthy();
    });

    it('refuses several resources', async () => {
      const res = await authorize([UBC, OTHER]);
      expect(params(res).get('error')).toBe('invalid_target');
    });

    it('refuses a code bound to one resource exchanged for another, without spending the code', async () => {
      const authorization = await authorize(UBC);
      const code = params(authorization).get('code')!;
      const wrong = await exchange(code, { resource: OTHER });
      expect(wrong.body.error).toBe('invalid_target');
      const own = await exchange(code, { resource: OWN });
      expect(own.body.error).toBe('invalid_target');
      const right = await exchange(code);
      expect(right.status).toBe(200);
      expect((await verify(right.body.access_token)).payload.aud).toBe(UBC);
    });

    it('never combines with the credential-write scope', async () => {
      const res = await authorize(UBC, { scope: 'credentials:write:some-server' });
      expect(params(res).get('error')).toBe('invalid_request');
    });

    it('is also refused on the consent page, before anything is shown', async () => {
      const res = await request(app)
        .get('/oauth/authorize')
        .query({
          client_id: 'rogue-pub',
          redirect_uri: REDIRECT,
          response_type: 'code',
          resource: OTHER,
          code_challenge: generateCodeChallenge(verifier),
          code_challenge_method: 'S256',
        });
      expect(res.status).toBe(302);
      expect(params(res).get('error')).toBe('invalid_target');
    });

    it('shows the configured name on the consent page for an allowed resource', async () => {
      const res = await request(app)
        .get('/oauth/authorize')
        .set('x-auth-token', aliceJwt)
        .set('Accept', 'application/json')
        .query({
          client_id: 'ubc-pub',
          redirect_uri: REDIRECT,
          response_type: 'code',
          resource: UBC,
          code_challenge: generateCodeChallenge(verifier),
          code_challenge_method: 'S256',
        });
      expect(res.body.resource).toMatchObject({ kind: 'external', name: 'UBC Courses', raw: UBC });
    });
  });

  describe('consent', () => {
    it('names the external resource by its configured name and exact URL', async () => {
      const shell = injectOAuthConsentShell as jest.Mock;
      shell.mockReturnValueOnce(null);
      const res = await request(app)
        .get('/oauth/authorize')
        .set('x-auth-token', aliceJwt)
        .query({
          client_id: 'ubc-pub',
          redirect_uri: REDIRECT,
          response_type: 'code',
          resource: UBC,
          code_challenge: generateCodeChallenge(verifier),
          code_challenge_method: 'S256',
        });
      expect(res.status).toBe(200);
      expect(res.text).toContain('UBC Courses');
      expect(res.text).toContain(UBC);
      // The SPA context carries the same two facts.
      const context = shell.mock.calls.at(-1)![0];
      expect(context.resource).toMatchObject({ kind: 'external', name: 'UBC Courses', raw: UBC });
    });
  });

  describe('refresh', () => {
    it('yields a new JWT for the same resource only', async () => {
      const pair = await issue(OTHER);
      const refreshed = await refresh(pair.refresh_token);
      expect(refreshed.status).toBe(200);
      const { payload } = await verify(refreshed.body.access_token, OTHER);
      expect(payload).toMatchObject({ aud: OTHER, sub: 'alice', client_id: 'ubc-pub' });
      expect(refreshed.body.access_token).not.toBe(pair.access_token);
      expect(refreshed.body.refresh_token).not.toBe(pair.refresh_token);
      // The rotated record stays bound.
      expect(tokens.every((token) => token.resource === OTHER)).toBe(true);
    });

    it('refuses a different resource, and a resource on an unbound grant, without spending the token', async () => {
      const pair = await issue(UBC);
      const other = await refresh(pair.refresh_token, { resource: OTHER });
      expect(other.body.error).toBe('invalid_target');
      const same = await refresh(pair.refresh_token, { resource: UBC });
      expect(same.status).toBe(200);

      const plain = await issue(null);
      const widened = await refresh(plain.refresh_token, { resource: UBC });
      expect(widened.body.error).toBe('invalid_target');
      expect((await refresh(plain.refresh_token)).status).toBe(200);
    });

    it('stops when the resource is removed or the client is no longer allowed', async () => {
      const pair = await issue(OTHER);
      oauthServerConfig = {
        enabled: true,
        externalResources: [{ resource: OTHER, name: 'Other', allowedClients: ['rogue-pub'] }],
      };
      expect((await refresh(pair.refresh_token)).body.error).toBe('invalid_grant');
      oauthServerConfig = { enabled: true, externalResources: [] };
      expect((await refresh(pair.refresh_token)).body.error).toBe('invalid_grant');
    });
  });

  describe('MCPHub never accepts these tokens', () => {
    it('rejects the JWT, and the internal record id, on every MCPHub bearer path', async () => {
      const pair = await issue();
      expect(tokens).toHaveLength(1);
      const internalId = tokens[0].accessToken;
      expect(internalId).not.toBe(pair.access_token);

      for (const bearer of [pair.access_token, internalId]) {
        expect(await resolveOAuthGrantFromToken(bearer)).toBeNull();
        expect(await resolveCredentialWriteGrantFromToken(bearer)).toBeNull();
        expect(
          (await request(app).post('/mcp').set('Authorization', `Bearer ${bearer}`)).status,
        ).toBe(401);
        expect(
          (await request(app).get('/api/anything').set('Authorization', `Bearer ${bearer}`)).status,
        ).toBe(401);
        expect(
          (await request(app).get('/oauth/userinfo').set('Authorization', `Bearer ${bearer}`))
            .status,
        ).toBe(401);
      }
    });

    it('does not accept the refresh token as a bearer either', async () => {
      const pair = await issue();
      expect(await resolveOAuthGrantFromToken(pair.refresh_token)).toBeNull();
    });
  });

  describe('signing keys', () => {
    const sidecar = () => `${process.env.MCPHUB_SETTING_PATH}.oauth-signing-keys.json`;

    it('persists across a restart and keeps verifying earlier tokens', async () => {
      const first = await issue();
      const firstJwks = await jwks();
      resetSigningKeyCache();
      expect(await jwks()).toEqual(firstJwks);
      await verify(first.access_token);
      const second = await issue();
      expect(decodeProtectedHeader(second.access_token).kid).toBe(firstJwks.keys[0].kid);
      await verify(second.access_token);
    });

    it('is stored 0600 with the private key sealed by the credential encryption key', async () => {
      await issue();
      const file = fs.readFileSync(sidecar(), 'utf8');
      expect(fs.statSync(sidecar()).mode & 0o777).toBe(0o600);
      expect(file).toContain('"privateKey":"enc:v1.');
      expect(file).not.toContain('PRIVATE KEY');
      expect(file).not.toContain('plain:');
    });

    it('creates the encryption key file when none is configured, like credential bindings', async () => {
      delete process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
      const pair = await issue();
      await verify(pair.access_token);
      expect(fs.existsSync(`${process.env.MCPHUB_SETTING_PATH}.credentials.key`)).toBe(true);
      expect(fs.readFileSync(sidecar(), 'utf8')).toContain('"privateKey":"enc:v1.');
    });

    it('fails closed, never storing a plain key, when the encryption key is unusable', async () => {
      process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = 'not-a-valid-key';
      const authorization = await authorize(UBC);
      const response = await exchange(params(authorization).get('code')!);
      expect(response.status).toBe(503);
      expect(response.body.error).toBe('server_error');
      expect(fs.existsSync(sidecar())).toBe(false);
      expect(tokens).toHaveLength(0);
      // Unauthenticated JWKS requests do not retry generation in a loop, and fail softly.
      process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      expect((await request(app).get('/.well-known/jwks.json')).body.keys).toEqual([]);
      expect(fs.existsSync(sidecar())).toBe(false);
      resetSigningKeyCache();
      expect((await request(app).get('/.well-known/jwks.json')).body.keys).toHaveLength(1);
    });

    it('never regenerates on a read path when the current key cannot be unlocked', async () => {
      const before = await issue();
      const stored = fs.readFileSync(sidecar(), 'utf8');
      const published = await jwks();
      process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
      resetSigningKeyCache();

      // JWKS requests keep serving the public keys and write nothing.
      expect(await jwks()).toEqual(published);
      expect(await jwks()).toEqual(published);
      expect(fs.readFileSync(sidecar(), 'utf8')).toBe(stored);

      // Issuing is refused, still without touching the keys.
      const authorization = await authorize(UBC);
      const refused = await exchange(params(authorization).get('code')!);
      expect(refused.status).toBe(503);
      expect(fs.readFileSync(sidecar(), 'utf8')).toBe(stored);
      await verify(before.access_token);

      // Only the explicit administrator rotation replaces it (a key that cannot sign is replaced
      // at once, whatever the activation delay).
      const rotated = await request(app)
        .post('/api/oauth/signing-keys/rotate')
        .set('x-auth-token', adminJwt);
      expect(rotated.status).toBe(200);
      const after = await issue();
      expect(decodeProtectedHeader(after.access_token).kid).toBe(rotated.body.data.kid);
      await verify(before.access_token);
      await verify(after.access_token);
    });

    it('pre-publishes a rotated key and starts signing with it only after the delay', async () => {
      const old = await issue();
      const oldKid = decodeProtectedHeader(old.access_token).kid;

      const rotated = await request(app)
        .post('/api/oauth/signing-keys/rotate')
        .set('x-auth-token', adminJwt);
      expect(rotated.status).toBe(200);
      expect(Object.keys(rotated.body.data).sort()).toEqual([
        'activatesAt',
        'kid',
        'removed',
        'retired',
      ]);
      expect(JSON.stringify(rotated.body)).not.toMatch(/PRIVATE|"d"/);
      const newKid = rotated.body.data.kid;
      expect(newKid).not.toBe(oldKid);

      // Published at once, and the verifier's cache is filled now.
      const cached = await jwks();
      expect(cached.keys.map((key: { kid: string }) => key.kid)).toEqual(
        expect.arrayContaining([oldKid, newKid]),
      );

      // During the delay the old key still signs.
      expect(decodeProtectedHeader((await issue()).access_token).kid).toBe(oldKid);

      // After the delay (900 s by default) the new key signs, and its token verifies against the
      // JWKS fetched before it activated.
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 901 * 1000);
      const fresh = await issue();
      expect(decodeProtectedHeader(fresh.access_token).kid).toBe(newKid);
      await jwtVerify(fresh.access_token, createLocalJWKSet(cached), {
        issuer: ISSUER,
        audience: UBC,
        typ: 'at+jwt',
      });
      await jwtVerify(old.access_token, createLocalJWKSet(cached), { audience: UBC });
      // The superseded key stays published for the tokens it signed.
      expect((await jwks()).keys.map((key: { kid: string }) => key.kid)).toEqual(
        expect.arrayContaining([oldKid, newKid]),
      );

      // Once the lifetime of the tokens it signed (plus skew) has passed, it is dropped.
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3600 * 1000 + 10 * 60 * 1000);
      expect((await jwks()).keys.map((key: { kid: string }) => key.kid)).toEqual([newKid]);
      const again = await request(app)
        .post('/api/oauth/signing-keys/rotate')
        .set('x-auth-token', adminJwt);
      expect(again.body.data.removed).toEqual([oldKid]);
    });

    it('signs at once with a rotated key when the delay is 0', async () => {
      oauthServerConfig = { ...oauthServerConfig, signingKeyActivationDelaySeconds: 0 };
      const old = await issue();
      const rotated = await request(app)
        .post('/api/oauth/signing-keys/rotate')
        .set('x-auth-token', adminJwt);
      expect(rotated.body.data.retired).toEqual([decodeProtectedHeader(old.access_token).kid]);
      const fresh = await issue();
      expect(decodeProtectedHeader(fresh.access_token).kid).toBe(rotated.body.data.kid);
      await verify(old.access_token);
      await verify(fresh.access_token);
    });

    it('lets only an administrator rotate', async () => {
      const response = await request(app)
        .post('/api/oauth/signing-keys/rotate')
        .set('x-auth-token', aliceJwt);
      expect(response.status).toBe(403);
      expect(fs.existsSync(sidecar())).toBe(false);
    });
  });

  describe('connected clients', () => {
    it('lists the grant as the client with the resource name', async () => {
      await issue(UBC);
      const [client] = await listConnectedClients('alice', systemConfig() as never);
      expect(client).toMatchObject({
        id: 'ubc-pub',
        name: 'UBC Connector (UBC Courses)',
        resources: ['UBC Courses'],
      });
    });

    it('keeps the plain name for a client with only MCPHub grants', async () => {
      await issue(null);
      const [client] = await listConnectedClients('alice', systemConfig() as never);
      expect(client.name).toBe('UBC Connector');
      expect(client.resources).toBeUndefined();
    });
  });
});
