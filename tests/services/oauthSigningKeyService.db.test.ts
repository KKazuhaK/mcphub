import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';

// Database mode: the repository is stood in for by an in-memory table (no database in CI).
type Row = Record<string, any>;
let table: Row[] = [];
const repository = {
  find: async () => table.map((row) => ({ ...row })),
  save: async (row: Row) => {
    table = [...table.filter((existing) => existing.kid !== row.kid), { ...row }];
    return row;
  },
  delete: async ({ kid }: { kid: string }) => {
    table = table.filter((row) => row.kid !== kid);
  },
};

jest.mock('../../src/db/connection.js', () => ({
  getAppDataSource: () => ({ getRepository: () => repository }),
}));
let oauthServer: Record<string, unknown> = { accessTokenLifetime: 600 };
jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({ get: async () => ({ oauthServer }) }),
}));
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getCredentialBindingDao: () => ({ hasBindings: async () => false }),
}));

import {
  getPublicJwks,
  resetSigningKeyCache,
  rotateSigningKey,
  signExternalAccessToken,
} from '../../src/services/oauthSigningKeyService.js';

const originalUseDb = process.env.USE_DB;
const originalKey = process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;

const sign = () =>
  signExternalAccessToken({
    issuer: 'https://hub.example.com',
    audience: 'https://ubc.example/mcp',
    subject: 'alice',
    clientId: 'c',
    scope: '',
    jti: 'j',
    expiresAt: new Date(Date.now() + 600_000),
  });

describe('OAuth signing keys in database mode', () => {
  beforeEach(() => {
    table = [];
    oauthServer = { accessTokenLifetime: 600 };
    process.env.USE_DB = 'true';
    process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    resetSigningKeyCache();
  });
  afterEach(() => {
    if (originalUseDb === undefined) delete process.env.USE_DB;
    else process.env.USE_DB = originalUseDb;
    if (originalKey === undefined) delete process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
    else process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = originalKey;
  });

  it('creates a key on first need and stores the private key sealed', async () => {
    const token = await sign();
    expect(table).toHaveLength(1);
    expect(table[0].privateKey).toMatch(/^enc:v1\./);
    expect(JSON.stringify(table[0])).not.toContain('PRIVATE KEY');
    expect(table[0].publicJwk.d).toBeUndefined();
    const jwks = await getPublicJwks();
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks), {
      issuer: 'https://hub.example.com',
      audience: 'https://ubc.example/mcp',
    });
    expect(protectedHeader).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid: table[0].kid });
    expect(payload.scope).toBe('');
  });

  it('keeps the same key across a restart', async () => {
    const first = decodeProtectedHeader(await sign()).kid;
    resetSigningKeyCache();
    expect(decodeProtectedHeader(await sign()).kid).toBe(first);
    expect(table).toHaveLength(1);
  });

  it('rotates with pre-publication: the new key is published first and signs after the delay', async () => {
    const oldToken = await sign();
    const oldKid = decodeProtectedHeader(oldToken).kid!;
    const rotated = await rotateSigningKey();
    expect(rotated.retired).toEqual([]);

    // A verifier fetches the JWKS now, before the new key signs anything.
    const cached = await getPublicJwks();
    expect(cached.keys.map((key) => key.kid)).toEqual(
      expect.arrayContaining([oldKid, rotated.kid]),
    );
    expect(decodeProtectedHeader(await sign()).kid).toBe(oldKid);

    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now + 901 * 1000);
    const fresh = await sign();
    expect(decodeProtectedHeader(fresh).kid).toBe(rotated.kid);
    // Verifies against the JWKS fetched before activation.
    await jwtVerify(fresh, createLocalJWKSet(cached), { audience: 'https://ubc.example/mcp' });
    await jwtVerify(oldToken, createLocalJWKSet(cached), { audience: 'https://ubc.example/mcp' });

    // The old key was retired at activation and is dropped after the window (600 s + 5 min).
    jest.spyOn(Date, 'now').mockReturnValue(now + 901 * 1000 + 16 * 60 * 1000);
    expect((await getPublicJwks()).keys.map((key) => key.kid)).toEqual([rotated.kid]);
    expect((await rotateSigningKey()).removed).toEqual([oldKid]);
    jest.restoreAllMocks();
  });

  it('does not create, retire or replace keys when the current one cannot be unlocked', async () => {
    await sign();
    const snapshot = JSON.stringify(table);
    process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    resetSigningKeyCache();
    await expect(sign()).rejects.toThrow(/cannot be unlocked/);
    expect((await getPublicJwks()).keys).toHaveLength(1);
    expect(JSON.stringify(table)).toBe(snapshot);
  });
});
