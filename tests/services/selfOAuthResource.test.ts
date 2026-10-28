import type { IOAuthClient } from '../../src/types/index.js';

// An in-memory stand-in for the TypeORM repository that behaves like `merge` + `save`: a
// property that is `undefined` in the update is skipped, `null` is written.
const rows = new Map<string, Record<string, any>>();
const mockRepository = {
  findByClientId: jest.fn(async (id: string) => rows.get(id) ?? null),
  create: jest.fn(async (data: Record<string, any>) => {
    rows.set(data.clientId, { ...data });
    return rows.get(data.clientId);
  }),
  update: jest.fn(async (id: string, data: Record<string, any>) => {
    const row = rows.get(id);
    if (!row) return null;
    for (const [key, value] of Object.entries(data)) if (value !== undefined) row[key] = value;
    return row;
  }),
};
jest.mock('../../src/db/repositories/OAuthClientRepository.js', () => ({
  OAuthClientRepository: jest.fn(() => mockRepository),
}));

jest.mock('../../src/controllers/oauthServerController.js', () => ({
  getMetadata: (_req: unknown, res: any) => res.json({}),
  postToken: (_req: unknown, res: any) => res.json({ ok: true }),
}));

let systemConfig: Record<string, any>;
jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({ get: async () => systemConfig }),
  getOAuthClientDao: () => {
    const { OAuthClientDaoDbImpl } = jest.requireActual('../../src/dao/OAuthClientDaoDbImpl.js');
    return new OAuthClientDaoDbImpl();
  },
}));
const mockRevoke = jest.fn(async () => 1);
jest.mock('../../src/models/OAuth.js', () => ({
  revokeUserClientResourceTokens: (...args: unknown[]) => (mockRevoke as any)(...args),
  findOAuthClientById: async (id: string) => rows.get(id) ?? null,
}));

import {
  SELF_OAUTH_CLIENT_ID,
  assertSelfClientIdAllowed,
  assertSelfClientIdInUse,
  buildSelfApp,
  ensureSelfOAuthClient,
  resolveSelfResource,
  revokeSelfGrants,
  selfResourceRefusal,
} from '../../src/services/selfOAuthResource.js';
import request from 'supertest';
import { CredentialBindingError } from '../../src/utils/credentialTemplate.js';
import { normalizeExternalResources } from '../../src/utils/externalResources.js';
import {
  regenerateSecret,
  updateClient,
  deleteClient,
} from '../../src/controllers/oauthClientController.js';

const URL_ = 'https://ubc.example/mcp';
const ISSUER = 'https://hub.example.com';
beforeEach(() => {
  rows.clear();
  mockRevoke.mockClear();
  systemConfig = {
    install: { baseUrl: `${ISSUER}/` },
    oauthServer: { externalResources: [{ resource: URL_, name: 'UBC' }] },
  };
});

const server = (oauth: Record<string, unknown> = { identityMode: 'personal' }, url = URL_) =>
  ({ type: 'streamable-http', url, oauth }) as any;

describe('resolveSelfResource', () => {
  it('wires a personal-OAuth server whose url is an external resource', async () => {
    expect(await resolveSelfResource(server())).toMatchObject({ issuer: ISSUER });
  });

  it.each([
    ['an explicit client id', { identityMode: 'personal', clientId: 'custom' }],
    ['explicit endpoints', { identityMode: 'personal', tokenEndpoint: 'https://x/token' }],
    ['shared identity', { identityMode: 'shared' }],
  ])('leaves a server with %s alone', async (_name, oauth) => {
    expect(await resolveSelfResource(server(oauth))).toBeUndefined();
  });

  it("keeps the public client's own id (stored by the SDK after authorizing) wired", async () => {
    expect(
      await resolveSelfResource(
        server({ identityMode: 'personal', clientId: SELF_OAUTH_CLIENT_ID }),
      ),
    ).toBeDefined();
  });

  it('needs the public base URL, an unchanged exact url and an enabled authorization server', async () => {
    expect(await resolveSelfResource(server(undefined, `${URL_}/`))).toBeUndefined();
    systemConfig.oauthServer.enabled = false;
    expect(await resolveSelfResource(server())).toBeUndefined();
    systemConfig.oauthServer.enabled = true;
    delete systemConfig.install;
    delete process.env.INSTALL_BASE_URL;
    expect(await resolveSelfResource(server())).toBeUndefined();
  });

  it('reports a clear refusal when allowedClients excludes the public client', async () => {
    systemConfig.oauthServer.externalResources[0].allowedClients = ['other'];
    const self = (await resolveSelfResource(server()))!;
    expect(selfResourceRefusal('ubc', self)).toContain(SELF_OAUTH_CLIENT_ID);
    systemConfig.oauthServer.externalResources[0].allowedClients = ['other', SELF_OAUTH_CLIENT_ID];
    expect(selfResourceRefusal('ubc', (await resolveSelfResource(server()))!)).toBeUndefined();
  });
});

describe('ensureSelfOAuthClient (database mode)', () => {
  it('creates a public client with the one callback derived from the public URL', async () => {
    await ensureSelfOAuthClient(ISSUER);
    expect(rows.get(SELF_OAUTH_CLIENT_ID)).toMatchObject({
      redirectUris: [`${ISSUER}/oauth/callback`],
      grants: ['authorization_code', 'refresh_token'],
    });
    expect(rows.get(SELF_OAUTH_CLIENT_ID)!.clientSecret).toBeUndefined();
  });

  it('heals a tampered record: secret cleared (null), redirect URIs replaced, not unioned', async () => {
    rows.set(SELF_OAUTH_CLIENT_ID, {
      clientId: SELF_OAUTH_CLIENT_ID,
      clientSecret: 'leaked-secret',
      name: 'edited',
      redirectUris: [`${ISSUER}/oauth/callback`, 'https://evil.example/cb'],
      grants: ['authorization_code', 'refresh_token', 'client_credentials'],
      scopes: ['read', 'write'],
    } satisfies Partial<IOAuthClient>);
    await ensureSelfOAuthClient(ISSUER);
    const row = rows.get(SELF_OAUTH_CLIENT_ID)!;
    expect(row.clientSecret).toBeNull();
    expect(row.redirectUris).toEqual([`${ISSUER}/oauth/callback`]);
    expect(row.grants).toEqual(['authorization_code', 'refresh_token']);
    expect(row.scopes).toEqual([]);
    // Idempotent: a healthy record is not written again.
    mockRepository.update.mockClear();
    await ensureSelfOAuthClient(ISSUER);
    expect(mockRepository.update).not.toHaveBeenCalled();
  });
});

describe('the dashboard cannot change the public client', () => {
  const run = async (handler: (req: any, res: any) => Promise<void>) => {
    rows.set(SELF_OAUTH_CLIENT_ID, {
      clientId: SELF_OAUTH_CLIENT_ID,
      redirectUris: [],
      grants: [],
    });
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await handler(
      { params: { clientId: SELF_OAUTH_CLIENT_ID }, body: {}, user: { isAdmin: true } },
      res,
    );
    return res;
  };
  it.each([
    ['update', updateClient],
    ['delete', deleteClient],
    ['regenerate secret', regenerateSecret],
  ])('answers 409 to %s', async (_name, handler) => {
    const res = await run(handler as any);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(rows.get(SELF_OAUTH_CLIENT_ID)!.redirectUris).toEqual([]);
  });
});

describe('revokeSelfGrants', () => {
  it('revokes by (user, public client, resource) for each distinct resource', async () => {
    await revokeSelfGrants('alice', [URL_, URL_, 'https://ubc.example/mcp2', undefined]);
    expect(mockRevoke).toHaveBeenCalledTimes(2);
    expect(mockRevoke).toHaveBeenCalledWith('alice', SELF_OAUTH_CLIENT_ID, URL_);
  });
});

describe('externalResources scopes', () => {
  it('accepts scope tokens and rejects anything else', () => {
    expect(
      normalizeExternalResources([{ resource: URL_, name: 'a', scopes: ['mcp:tools'] }])[0].scopes,
    ).toEqual(['mcp:tools']);
    for (const scopes of [['has space'], [''], 'read', [1], ['a"b']]) {
      expect(() => normalizeExternalResources([{ resource: URL_, name: 'a', scopes }])).toThrow(
        /scopes/,
      );
    }
  });
});

describe('reserved client id', () => {
  const named = (url = URL_) =>
    server({ identityMode: 'personal', clientId: SELF_OAUTH_CLIENT_ID }, url);

  it('is refused at save time unless the url is an external resource', async () => {
    await expect(assertSelfClientIdAllowed(named('https://elsewhere.example/mcp'))).rejects.toThrow(
      /reserved/,
    );
    await expect(
      assertSelfClientIdAllowed(named('https://elsewhere.example/mcp')),
    ).rejects.toBeInstanceOf(CredentialBindingError);
    await expect(assertSelfClientIdAllowed(named())).resolves.toBeUndefined();
    await expect(
      assertSelfClientIdAllowed(server({ identityMode: 'personal', clientId: 'mine' })),
    ).resolves.toBeUndefined();
  });

  it('is refused at connect time when the server is not a self-resource server', async () => {
    const other = named('https://elsewhere.example/mcp');
    await expect(
      assertSelfClientIdInUse('x', other, await resolveSelfResource(other)),
    ).rejects.toThrow(/reserved/);
    await expect(
      assertSelfClientIdInUse('x', named(), await resolveSelfResource(named())),
    ).resolves.toBeUndefined();
  });
});

describe('the loopback limiter', () => {
  it("keeps one user's burst from limiting another user's refresh", async () => {
    const app = await buildSelfApp({ perKey: 2, ceiling: 100 });
    const post = (key: string) =>
      request(app).post('/oauth/token').set('x-mcphub-self-key', key).type('form').send({});
    expect((await post('alice')).status).toBe(200);
    expect((await post('alice')).status).toBe(200);
    expect((await post('alice')).status).toBe(429);
    expect((await post('bob')).status).toBe(200);
  });

  it('still has a ceiling over all users', async () => {
    const app = await buildSelfApp({ perKey: 100, ceiling: 2 });
    const post = (key: string) =>
      request(app).post('/oauth/token').set('x-mcphub-self-key', key).type('form').send({});
    await post('a');
    await post('b');
    expect((await post('c')).status).toBe(429);
  });
});
