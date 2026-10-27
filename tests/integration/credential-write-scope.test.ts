import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { CredentialBindingDaoImpl } from '../../src/dao/CredentialBindingDao.js';
import type { IUser, IOAuthToken, ServerConfig } from '../../src/types/index.js';

type StoredServer = ServerConfig & { name: string };

let users: IUser[];
let tokens: IOAuthToken[];
let servers: StoredServer[];
let oauthServerConfig: Record<string, unknown>;
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
const activityCreate = jest.fn(async () => undefined);
const notifyWorkspaceUserMock = jest.fn(async () => undefined);
let capturedUser: Record<string, unknown> | undefined;

jest.mock('../../src/dao/index.js', () => ({
  getUserDao: () => ({
    findAll: async () => users,
    findByUsername: async (username: string) => users.find((user) => user.username === username),
  }),
  getBearerKeyDao: () => ({ findEnabled: async () => [] }),
  getOAuthClientDao: () => ({
    findByClientId: async (id: string) => clients[id],
  }),
  getOAuthTokenDao: () => ({
    findByAccessToken: async (value: string) => tokens.find((token) => token.accessToken === value),
    findByRefreshToken: async (value: string) =>
      tokens.find((token) => token.refreshToken === value),
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
  getGroupDao: () => ({ findAll: async () => [] }),
  getServerDao: () => ({
    findById: async (name: string) => servers.find((s) => s.name === name) ?? null,
    findAll: async () => servers,
  }),
  getSystemConfigDao: () => ({ get: async () => ({ oauthServer: oauthServerConfig }) }),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getSystemConfigDao: () => ({ get: async () => ({ oauthServer: oauthServerConfig }) }),
  getServerDao: () => ({
    findById: async (name: string) => servers.find((s) => s.name === name) ?? null,
    findAll: async () => servers,
  }),
  getCredentialBindingDao: () => new CredentialBindingDaoImpl(),
  getUserDao: () => ({
    findByUsername: async (username: string) => users.find((user) => user.username === username),
  }),
  isActivityLoggingEnabled: () => true,
  getActivityDao: () => ({ create: (...args: unknown[]) => (activityCreate as any)(...args) }),
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
jest.mock('../../src/services/userServerStatusService.js', () => ({
  notifyWorkspaceUser: (...args: unknown[]) => (notifyWorkspaceUserMock as any)(...args),
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
  postAuthorize,
  postToken,
  getUserInfo,
} from '../../src/controllers/oauthServerController.js';
import {
  listMyCredentials,
  updateMyCredential,
} from '../../src/controllers/credentialBindingController.js';
import {
  initOAuthServer,
  generateCodeChallenge,
  getOAuthModel,
} from '../../src/services/oauthServerService.js';
import {
  computeDestinationFingerprint,
  getCredentialBindingStatus,
  saveCredentialBinding,
} from '../../src/services/credentialBindingService.js';
import {
  resolveOAuthGrantFromToken,
  resolveOAuthUserFromToken,
} from '../../src/utils/oauthBearer.js';
import { getUserSessionVersion } from '../../src/utils/userSession.js';
import { injectOAuthConsentShell } from '../../src/utils/frontendShell.js';

const SCOPE = 'credentials:write:ubc-personal';
const OTHER_SCOPE = 'credentials:write:other-personal';
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

const slotServer = (name: string, allowed: string[]): StoredServer => ({
  name,
  type: 'stdio',
  command: 'node',
  owner: 'admin',
  visibility: 'public',
  env: { UBC_TOKEN: 'org-default' },
  credentialTemplate: [{ target: 'env', name: 'UBC_TOKEN', label: 'UBC token' }],
  credentialWriteClients: allowed,
});

let directory: string;
const originalPath = process.env.MCPHUB_SETTING_PATH;
const originalKey = process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;

describe('credentials:write:<server> OAuth scope', () => {
  let app: express.Application;
  let aliceJwt: string;
  let adminJwt: string;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-cw-'));
    process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
    process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    jest.clearAllMocks();
    capturedUser = undefined;
    oauthServerConfig = { enabled: true };
    users = [
      { username: 'admin', password: await bcrypt.hash('x', 4), isAdmin: true },
      { username: 'alice', password: await bcrypt.hash('x', 4), isAdmin: false },
      { username: 'bob', password: await bcrypt.hash('x', 4), isAdmin: false },
    ];
    tokens = [];
    servers = [
      slotServer('ubc-personal', ['ubc-pub']),
      slotServer('other-personal', ['ubc-pub']),
      { ...slotServer('no-slots', ['ubc-pub']), credentialTemplate: undefined },
      slotServer('closed-personal', []),
    ];
    aliceJwt = userJwt(users[1]);
    adminJwt = userJwt(users[0]);
    await initOAuthServer();

    app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => {
      (req as any).t = (key: string, options?: { client?: string; server?: string }) =>
        key === 'oauthServer.credentialWrite'
          ? `${options?.client} wants to set your personal credentials for ${options?.server}`
          : key;
      next();
    });
    app.get('/oauth/authorize', getAuthorize);
    app.post('/oauth/authorize', postAuthorize);
    app.post('/oauth/token', postToken);
    app.get('/oauth/userinfo', getUserInfo);
    app.use('/api', auth, (req, _res, next) => {
      capturedUser = (req as any).user;
      next();
    });
    app.get('/api/credentials', listMyCredentials);
    app.put('/api/credentials/:name', updateMyCredential);
    app.delete('/api/credentials/:name', updateMyCredential);
    app.get('/api/servers', (_req, res) => res.json({ success: true, data: ['everything'] }));
    app.post('/api/servers', (_req, res) => res.json({ success: true }));
    app.post('/mcp', async (req, res) => {
      const grant = await resolveOAuthGrantFromToken(req.headers.authorization?.slice(7));
      res.status(grant ? 200 : 401).json({});
    });
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
    if (originalPath === undefined) delete process.env.MCPHUB_SETTING_PATH;
    else process.env.MCPHUB_SETTING_PATH = originalPath;
    if (originalKey === undefined) delete process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = originalKey;
  });

  const authorize = (
    scope: string | undefined,
    { client = 'ubc-pub', jwtValue = aliceJwt, allow = 'true' } = {},
  ) =>
    request(app)
      .post('/oauth/authorize')
      .send({
        allow,
        client_id: client,
        redirect_uri: REDIRECT,
        response_type: 'code',
        ...(scope === undefined ? {} : { scope }),
        token: jwtValue,
        code_challenge: generateCodeChallenge(verifier),
        code_challenge_method: 'S256',
      });
  const locationParams = (res: request.Response) => new URL(res.headers.location).searchParams;
  const exchange = (code: string, client = 'ubc-pub') =>
    request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      client_id: client,
      redirect_uri: REDIRECT,
      code,
      code_verifier: verifier,
    });
  const issue = async (scope: string, options: Parameters<typeof authorize>[1] = {}) => {
    const authorization = await authorize(scope, options);
    expect(authorization.status).toBe(302);
    const code = locationParams(authorization).get('code');
    expect(code).toBeTruthy();
    const response = await exchange(code!, options.client);
    expect(response.status).toBe(200);
    return response.body as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      scope: string;
    };
  };
  const put = (token: string, name: string, values: unknown = { 'env.UBC_TOKEN': 'secret-1' }) =>
    request(app).put(`/api/credentials/${name}`).auth(token, { type: 'bearer' }).send({ values });
  const del = (token: string, name: string) =>
    request(app).delete(`/api/credentials/${name}`).auth(token, { type: 'bearer' });

  describe('authorization', () => {
    it('grants the scope to a listed client', async () => {
      const res = await authorize(SCOPE);
      expect(res.status).toBe(302);
      expect(locationParams(res).get('code')).toBeTruthy();
      expect(locationParams(res).get('error')).toBeNull();
    });

    it('refuses a client the server does not list', async () => {
      const res = await authorize(SCOPE, { client: 'rogue-pub' });
      expect(res.status).toBe(302);
      expect(locationParams(res).get('error')).toBe('invalid_scope');
      expect(locationParams(res).get('code')).toBeNull();
    });

    it('refuses a server with an empty client list, an unknown server and a server without slots', async () => {
      for (const scope of [
        'credentials:write:closed-personal',
        'credentials:write:missing',
        'credentials:write:no-slots',
        'credentials:write:',
      ]) {
        const res = await authorize(scope);
        expect(locationParams(res).get('error')).toBe('invalid_scope');
      }
    });

    it('refuses mixing with any other scope, in either order and for two credential scopes', async () => {
      for (const scope of [
        `read ${SCOPE}`,
        `${SCOPE} write`,
        `${SCOPE} ${OTHER_SCOPE}`,
        `${SCOPE} ${SCOPE}`,
      ]) {
        const res = await authorize(scope);
        expect(locationParams(res).get('error')).toBe('invalid_scope');
        expect(locationParams(res).get('code')).toBeNull();
      }
    });

    it('is never granted implicitly: default scopes and configured allowedScopes exclude it', async () => {
      oauthServerConfig = { enabled: true, allowedScopes: ['read', SCOPE] };
      const model = getOAuthModel();
      const client = { id: 'ubc-pub' } as never;
      expect(await model.validateScope!({} as never, client, undefined)).toEqual(['read']);
      expect(await model.validateScope!({} as never, client, [])).toEqual(['read']);
      expect(await model.validateScope!({} as never, client, ['read'])).toEqual(['read']);
      // An admin listing the pattern in allowedScopes does not make it a plain scope.
      expect(await model.validateScope!({} as never, client, ['credentials:write:nope'])).toBe(
        false,
      );
      const implicit = await authorize(undefined);
      const params = locationParams(implicit);
      const issued = await exchange(params.get('code')!);
      expect(issued.body.scope).toBe('read');
    });

    it('lets a plain read scope work exactly as before', async () => {
      const pair = await issue('read');
      expect(pair.scope).toBe('read');
      expect(pair.expires_in).toBeGreaterThan(300);
      expect(pair.refresh_token).toBeTruthy();
    });
  });

  describe('consent page', () => {
    const consent = (scope: string, client = 'ubc-pub') =>
      request(app)
        .get('/oauth/authorize')
        .query({
          client_id: client,
          redirect_uri: REDIRECT,
          response_type: 'code',
          scope,
          state: 's1',
          code_challenge: generateCodeChallenge(verifier),
          code_challenge_method: 'S256',
          resource: 'https://hub.example/mcp',
        });

    it('hands the SPA one credential-write sentence and nothing else', async () => {
      const res = await consent(SCOPE);
      expect(res.status).toBe(200);
      const context = (injectOAuthConsentShell as jest.Mock).mock.calls.at(-1)![0];
      expect(context.credentialWrite).toEqual({ serverName: 'ubc-personal' });
      expect(context.clientName).toBe('UBC Connector');
      expect(context.scopes).toEqual([]);
      expect(context.resource).toBeUndefined();
    });

    it('renders the localized sentence in the fallback page without scope rows', async () => {
      (injectOAuthConsentShell as jest.Mock).mockReturnValueOnce(null);
      const res = await request(app)
        .get('/oauth/authorize')
        .set('x-auth-token', aliceJwt)
        .query({
          client_id: 'ubc-pub',
          redirect_uri: REDIRECT,
          response_type: 'code',
          scope: SCOPE,
          code_challenge: generateCodeChallenge(verifier),
          code_challenge_method: 'S256',
        });
      expect(res.status).toBe(200);
      expect(res.text).toContain(
        'UBC Connector wants to set your personal credentials for ubc-personal',
      );
      expect(res.text).not.toContain('This application will be able to');
    });

    it('redirects an ineligible or mixed request with invalid_scope instead of asking for consent', async () => {
      for (const [scope, client] of [
        [SCOPE, 'rogue-pub'],
        [`read ${SCOPE}`, 'ubc-pub'],
        ['credentials:write:missing', 'ubc-pub'],
      ]) {
        const res = await consent(scope, client);
        expect(res.status).toBe(302);
        expect(locationParams(res).get('error')).toBe('invalid_scope');
        expect(locationParams(res).get('state')).toBe('s1');
      }
    });

    it('leaves the ordinary consent untouched', async () => {
      await consent('read write');
      const context = (injectOAuthConsentShell as jest.Mock).mock.calls.at(-1)![0];
      expect(context.credentialWrite).toBeUndefined();
      expect(context.scopes.map((s: { name: string }) => s.name)).toEqual(['read', 'write']);
    });
  });

  describe('token exchange', () => {
    it('issues a five-minute access token and no refresh token', async () => {
      const pair = await issue(SCOPE);
      expect(pair.scope).toBe(SCOPE);
      expect(pair.expires_in).toBeLessThanOrEqual(300);
      expect(pair.expires_in).toBeGreaterThan(0);
      expect(pair.refresh_token).toBeUndefined();
      expect(tokens[0].refreshToken).toBeUndefined();
      expect(tokens[0].refreshTokenExpiresAt).toBeUndefined();
    });

    it('never lets a refresh grant renew a credential-write grant', async () => {
      const pair = await issue(SCOPE);
      const res = await request(app).post('/oauth/token').type('form').send({
        grant_type: 'refresh_token',
        client_id: 'ubc-pub',
        refresh_token: pair.access_token,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error).toBeDefined();
    });

    it('re-checks the client at exchange: a code for a client dropped meanwhile is refused', async () => {
      const authorization = await authorize(SCOPE);
      const code = locationParams(authorization).get('code')!;
      servers[0].credentialWriteClients = [];
      const res = await exchange(code);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.access_token).toBeUndefined();
    });
  });

  describe('credential endpoints', () => {
    it('saves the token user binding with the destination fingerprint, and only theirs', async () => {
      await saveCredentialBinding('ubc-personal', 'bob', servers[0], {
        'env.UBC_TOKEN': 'bob-value',
      });
      const pair = await issue(SCOPE);

      const res = await put(pair.access_token, 'ubc-personal');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

      const dao = new CredentialBindingDaoImpl();
      const stored = await dao.get('ubc-personal', 'alice');
      expect(stored?.destinationFingerprint).toBe(await computeDestinationFingerprint(servers[0]));
      expect(JSON.stringify(stored)).not.toContain('secret-1');
      expect(
        (await getCredentialBindingStatus('ubc-personal', 'alice', servers[0])).configured,
      ).toBe(true);
      // Bob's binding is unchanged: the user is the token's, never a parameter.
      const bob = await dao.get('ubc-personal', 'bob');
      expect(bob?.updatedAt).toBeDefined();
      await put(pair.access_token, 'ubc-personal', { 'env.UBC_TOKEN': 'secret-2' });
      expect(await dao.get('ubc-personal', 'bob')).toEqual(bob);
    });

    it('applies the same validation as the dashboard', async () => {
      const pair = await issue(SCOPE);
      for (const values of [{}, { 'env.UBC_TOKEN': '' }, { 'env.OTHER': 'x' }, 'nope']) {
        const res = await put(pair.access_token, 'ubc-personal', values);
        expect(res.status).toBe(400);
      }
      expect(await new CredentialBindingDaoImpl().get('ubc-personal', 'alice')).toBeNull();
    });

    it('deletes the token user binding', async () => {
      const pair = await issue(SCOPE);
      await put(pair.access_token, 'ubc-personal');
      const res = await del(pair.access_token, 'ubc-personal');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(await new CredentialBindingDaoImpl().get('ubc-personal', 'alice')).toBeNull();
    });

    it('answers 403 for any other server, even one that lists the same client', async () => {
      const pair = await issue(SCOPE);
      expect((await put(pair.access_token, 'other-personal')).status).toBe(403);
      expect((await del(pair.access_token, 'other-personal')).status).toBe(403);
      expect((await put(pair.access_token, 'missing')).status).toBe(403);
      expect(await new CredentialBindingDaoImpl().get('other-personal', 'alice')).toBeNull();
    });

    it('is rejected on MCP routes, other /api routes and the credential list', async () => {
      const pair = await issue(SCOPE);
      const bearer = { type: 'bearer' as const };
      expect((await request(app).post('/mcp').auth(pair.access_token, bearer)).status).toBe(401);
      expect(await resolveOAuthUserFromToken(pair.access_token)).toBeNull();
      expect((await request(app).get('/api/servers').auth(pair.access_token, bearer)).status).toBe(
        401,
      );
      expect(
        (await request(app).post('/api/servers').auth(pair.access_token, bearer).send({})).status,
      ).toBe(401);
      expect(
        (await request(app).get('/api/credentials').auth(pair.access_token, bearer)).status,
      ).toBe(401);
      expect(
        (await request(app).get('/api/credentials/ubc-personal').auth(pair.access_token, bearer))
          .status,
      ).toBe(401);
    });

    it('does not widen for an administrator', async () => {
      const pair = await issue(SCOPE, { jwtValue: adminJwt });
      const bearer = { type: 'bearer' as const };
      expect((await request(app).get('/api/servers').auth(pair.access_token, bearer)).status).toBe(
        401,
      );
      expect((await put(pair.access_token, 'other-personal')).status).toBe(403);
      expect((await put(pair.access_token, 'ubc-personal')).status).toBe(200);
      expect(capturedUser).toMatchObject({
        username: 'admin',
        isAdmin: false,
        credentialWriteGrant: { clientId: 'ubc-pub', serverName: 'ubc-personal' },
      });
      expect(await resolveOAuthUserFromToken(pair.access_token)).toBeNull();
    });

    it('stops working as soon as the client is removed from the server', async () => {
      const pair = await issue(SCOPE);
      servers[0].credentialWriteClients = ['someone-else'];
      expect((await put(pair.access_token, 'ubc-personal')).status).toBe(401);
      expect(
        (await request(app).get('/oauth/userinfo').auth(pair.access_token, { type: 'bearer' }))
          .status,
      ).toBe(401);
    });

    it('stops working when the server loses its credential slots or the token expires', async () => {
      const pair = await issue(SCOPE);
      servers[0].credentialTemplate = undefined;
      expect((await put(pair.access_token, 'ubc-personal')).status).toBe(401);
      servers[0].credentialTemplate = [{ target: 'env', name: 'UBC_TOKEN', label: 'UBC token' }];
      expect((await put(pair.access_token, 'ubc-personal')).status).toBe(200);
      tokens[0].accessTokenExpiresAt = new Date(Date.now() - 1000);
      expect((await put(pair.access_token, 'ubc-personal')).status).toBe(401);
    });

    it('does not accept a different credential-write token as a plain dashboard credential', async () => {
      const res = await request(app)
        .put('/api/credentials/ubc-personal')
        .auth('not-a-token', { type: 'bearer' })
        .send({ values: { 'env.UBC_TOKEN': 'x' } });
      expect(res.status).toBe(401);
    });

    it('still serves the dashboard session on the same routes', async () => {
      const res = await request(app)
        .put('/api/credentials/ubc-personal')
        .set('x-auth-token', aliceJwt)
        .send({ values: { 'env.UBC_TOKEN': 'dash' } });
      expect(res.status).toBe(200);
      expect(activityCreate).not.toHaveBeenCalled();
    });
  });

  describe('userinfo', () => {
    it('returns the username as sub', async () => {
      const pair = await issue(SCOPE);
      const res = await request(app)
        .get('/oauth/userinfo')
        .auth(pair.access_token, { type: 'bearer' });
      expect(res.status).toBe(200);
      expect(res.body.sub).toBe('alice');
    });
  });

  describe('audit and notification', () => {
    it('records who, which client and which server, without the value', async () => {
      const pair = await issue(SCOPE);
      await put(pair.access_token, 'ubc-personal', { 'env.UBC_TOKEN': 'very-secret-value' });
      await del(pair.access_token, 'ubc-personal');
      const rows = activityCreate.mock.calls.map((call) => (call as unknown[])[0] as any);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        server: 'ubc-personal',
        tool: 'credentials.write',
        status: 'success',
        username: 'alice',
        clientKind: 'oauth',
        clientId: 'ubc-pub',
      });
      expect(rows[1]).toMatchObject({ tool: 'credentials.delete', status: 'success' });
      expect(JSON.stringify(rows)).not.toContain('very-secret-value');
    });

    it('records a refused write as an error row without the validation message', async () => {
      const pair = await issue(SCOPE);
      await put(pair.access_token, 'ubc-personal', { 'env.UBC_TOKEN': '' });
      const row = activityCreate.mock.calls.at(-1)![0] as any;
      expect(row).toMatchObject({ status: 'error', tool: 'credentials.write' });
      expect(row.errorMessage).toBeUndefined();
    });

    it('notifies the token user sessions like a dashboard write', async () => {
      const pair = await issue(SCOPE);
      await put(pair.access_token, 'ubc-personal');
      expect(notifyWorkspaceUserMock).toHaveBeenCalledWith('alice');
      expect(notifyWorkspaceUserMock).toHaveBeenCalledTimes(1);
      notifyWorkspaceUserMock.mockClear();
      await del(pair.access_token, 'ubc-personal');
      expect(notifyWorkspaceUserMock).toHaveBeenCalledWith('alice');
    });
  });
});
