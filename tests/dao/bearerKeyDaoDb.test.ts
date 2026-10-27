import { createHash } from 'node:crypto';

const rows: any[] = [];
const repository = {
  findAll: jest.fn(async () => rows),
  findById: jest.fn(async (id: string) => rows.find((row) => row.id === id) ?? null),
  findByTokenHash: jest.fn(
    async (hash: string) => rows.find((row) => row.tokenHash === hash) ?? null,
  ),
  findWithPlaintextToken: jest.fn(async () => rows.filter((row) => row.token)),
  replacePlaintextToken: jest.fn(
    async (id: string, plaintext: string, tokenHash: string, tokenPrefix: string) => {
      const row = rows.find((candidate) => candidate.id === id && candidate.token === plaintext);
      if (!row) return false;
      Object.assign(row, { token: null, tokenHash, tokenPrefix });
      return true;
    },
  ),
  create: jest.fn(async (data: any) => {
    const row = { id: `id-${rows.length + 1}`, createdAt: new Date(), ...data };
    rows.push(row);
    return row;
  }),
  update: jest.fn(),
  delete: jest.fn(),
  deleteByOwner: jest.fn(),
  findByOwner: jest.fn(),
  recordLastUsed: jest.fn(),
};
jest.mock('../../src/db/repositories/BearerKeyRepository.js', () => ({
  BearerKeyRepository: jest.fn(() => repository),
}));

import { BearerKeyDaoDbImpl, resetLegacyMigrationState } from '../../src/dao/BearerKeyDaoDbImpl.js';
import { generateBearerToken } from '../../src/utils/bearerKeyHash.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('BearerKeyDaoDbImpl hashing', () => {
  beforeEach(() => {
    rows.length = 0;
    jest.clearAllMocks();
    resetLegacyMigrationState();
  });

  it('writes only the hash and prefix, returns the plaintext once, and finds by hash', async () => {
    const dao = new BearerKeyDaoDbImpl();
    const token = generateBearerToken();

    const created = await dao.create({
      name: 'one',
      token,
      enabled: true,
      kind: 'system',
      accessType: 'all',
    });

    expect(created.token).toBe(token);
    expect(rows[0].token).toBeNull();
    expect(rows[0].tokenHash).toBe(sha256(token));
    expect(rows[0].tokenPrefix).toBe(token.slice(0, 8));
    expect(JSON.stringify(repository.create.mock.calls)).not.toContain(token);

    const found = await dao.findByToken(token);
    expect(found?.id).toBe(created.id);
    expect(found?.token).toBeUndefined();
    expect((await dao.findAll())[0].token).toBeUndefined();
    expect(await dao.findByToken(`${token}x`)).toBeUndefined();
  });

  it('hashes rows left in plaintext by an older version, idempotently and conditionally', async () => {
    rows.push({
      id: 'legacy',
      name: 'legacy',
      token: 'legacy-plaintext-token-0123456789',
      tokenHash: null,
      enabled: true,
      kind: 'system',
      accessType: 'all',
    });
    const dao = new BearerKeyDaoDbImpl();

    // Until the migration runs the row still authenticates, and exposes no plaintext.
    const before = await dao.findByToken('legacy-plaintext-token-0123456789');
    expect(before?.id).toBe('legacy');
    expect(before?.token).toBeUndefined();

    expect(await dao.migrateLegacyTokens()).toBe(1);
    expect(await dao.migrateLegacyTokens()).toBe(0);

    expect(rows[0].token).toBeNull();
    expect(rows[0].tokenHash).toBe(sha256('legacy-plaintext-token-0123456789'));
    expect((await dao.findByToken('legacy-plaintext-token-0123456789'))?.id).toBe('legacy');
    // The write is conditioned on the plaintext still being in the row.
    expect(repository.replacePlaintextToken).toHaveBeenCalledWith(
      'legacy',
      'legacy-plaintext-token-0123456789',
      sha256('legacy-plaintext-token-0123456789'),
      expect.any(String),
    );
  });

  it('stops scanning legacy rows once the startup migration has completed', async () => {
    const dao = new BearerKeyDaoDbImpl();
    expect(await dao.migrateLegacyTokens()).toBe(0);
    repository.findWithPlaintextToken.mockClear();

    expect(await dao.findByToken('not-a-key')).toBeUndefined();

    expect(repository.findWithPlaintextToken).not.toHaveBeenCalled();
  });

  it('keeps the fallback scan while a row could not be migrated', async () => {
    rows.push({
      id: 'stuck',
      name: 's',
      token: 'stuck-plaintext-token-01',
      tokenHash: null,
      enabled: true,
    });
    repository.replacePlaintextToken.mockResolvedValueOnce(false);
    const dao = new BearerKeyDaoDbImpl();

    await dao.migrateLegacyTokens();

    expect((await dao.findByToken('stuck-plaintext-token-01'))?.id).toBe('stuck');
  });
});
