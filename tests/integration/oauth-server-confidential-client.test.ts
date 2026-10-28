// End-to-end authorization code flow against the real OAuth authorization
// server (real controller, service and model; only persistence is faked).
// Regression: confidential clients must be able to reach /oauth/authorize
// (the library looks the client up with a null secret there) while the token
// endpoint keeps authenticating them.
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

const clients = new Map<string, Record<string, unknown>>();
const tokens: Record<string, any>[] = [];

jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({
    get: async () => ({ oauthServer: { enabled: true, requireClientSecret: true } }),
  }),
  getOAuthClientDao: () => ({
    findByClientId: async (id: string) => clients.get(id) ?? null,
  }),
  getOAuthTokenDao: () => ({
    create: async (token: Record<string, any>) => {
      tokens.push(token);
      return token;
    },
    findByAccessToken: async (t: string) => tokens.find((x) => x.accessToken === t) ?? null,
    findByRefreshToken: async (t: string) => tokens.find((x) => x.refreshToken === t) ?? null,
    revokeToken: async () => true,
  }),
  getUserDao: () => ({
    findByUsername: async (username: string) => ({ username, password: 'hashed' }),
  }),
  getBearerKeyDao: jest.fn(),
}));

jest.mock('../../src/models/User.js', () => ({
  findUserByUsername: jest.fn(),
  verifyPassword: jest.fn(),
}));

jest.mock('../../src/services/betterAuthSession.js', () => ({
  resolveBetterAuthUser: jest.fn(),
}));

import { postAuthorize, postToken } from '../../src/controllers/oauthServerController.js';
import { getUserSessionVersion } from '../../src/utils/userSession.js';
import { initOAuthServer } from '../../src/services/oauthServerService.js';

const REDIRECT = 'https://app.example/cb';
const SECRET = 'top-secret';

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  (req as any).user = {
    username: 'alice',
    isAdmin: false,
    sessionVersion: getUserSessionVersion({ username: 'alice', password: 'hashed' }),
  };
  next();
});
app.post('/oauth/authorize', postAuthorize);
app.post('/oauth/token', postToken);

const pkcePair = () => {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const authorize = async (clientId: string, challenge?: string): Promise<string> => {
  const res = await request(app)
    .post('/oauth/authorize')
    .type('form')
    .send({
      allow: 'true',
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: 'code',
      state: 'xyz',
      ...(challenge ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
    });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.location);
  expect(location.searchParams.get('error')).toBeNull();
  const code = location.searchParams.get('code');
  expect(code).toBeTruthy();
  return code as string;
};

const exchange = (body: Record<string, string>) =>
  request(app)
    .post('/oauth/token')
    .type('form')
    .send({ grant_type: 'authorization_code', redirect_uri: REDIRECT, ...body });

beforeAll(async () => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  await initOAuthServer();
});

beforeEach(() => {
  tokens.length = 0;
  clients.clear();
  clients.set('conf-client', {
    clientId: 'conf-client',
    clientSecret: SECRET,
    redirectUris: [REDIRECT],
    grants: ['authorization_code', 'refresh_token'],
  });
  clients.set('pub-client', {
    clientId: 'pub-client',
    redirectUris: [REDIRECT],
    grants: ['authorization_code', 'refresh_token'],
  });
});

afterAll(() => jest.restoreAllMocks());

describe('authorization code flow for a confidential client', () => {
  it('authorizes and issues tokens when the correct secret is presented', async () => {
    const code = await authorize('conf-client');
    const res = await exchange({ code, client_id: 'conf-client', client_secret: SECRET });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
  });

  it('rejects the token request with a wrong secret', async () => {
    const code = await authorize('conf-client');
    const res = await exchange({ code, client_id: 'conf-client', client_secret: 'wrong' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
  });

  it('rejects the token request with no secret', async () => {
    const code = await authorize('conf-client');
    const res = await exchange({ code, client_id: 'conf-client' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    expect(res.body.access_token).toBeUndefined();
  });

  it('rejects a PKCE-only token request that omits the secret', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await authorize('conf-client', challenge);
    const res = await exchange({ code, client_id: 'conf-client', code_verifier: verifier });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    expect(res.body.access_token).toBeUndefined();
  });

  it('refuses to authorize an unknown client', async () => {
    const res = await request(app)
      .post('/oauth/authorize')
      .type('form')
      .send({ allow: 'true', client_id: 'ghost', redirect_uri: REDIRECT, response_type: 'code' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
  });
});

describe('authorization code flow for a public client', () => {
  it('still works with PKCE and no secret', async () => {
    const { verifier, challenge } = pkcePair();
    const code = await authorize('pub-client', challenge);
    const res = await exchange({ code, client_id: 'pub-client', code_verifier: verifier });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
  });
});
