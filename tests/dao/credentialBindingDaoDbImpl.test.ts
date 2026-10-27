const mockRepository = {
  find: jest.fn(),
  upsert: jest.fn(),
};

jest.mock('../../src/db/connection.js', () => ({
  getAppDataSource: () => ({
    getRepository: () => mockRepository,
  }),
}));

import { IsNull } from 'typeorm';
import { CredentialBindingDaoDbImpl } from '../../src/dao/CredentialBindingDaoDbImpl.js';

describe('CredentialBindingDaoDbImpl.listUsernames', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('selects only the usernames bound to the requested server', async () => {
    mockRepository.find.mockResolvedValue([{ username: 'alice' }, { username: 'bob' }]);

    await expect(
      new CredentialBindingDaoDbImpl().listUsernames('private-api'),
    ).resolves.toEqual(['alice', 'bob']);

    expect(mockRepository.find).toHaveBeenCalledWith({
      where: { serverName: 'private-api' },
      select: { username: true },
    });
  });

  it('returns an empty list when no user bound the server', async () => {
    mockRepository.find.mockResolvedValue([]);

    await expect(
      new CredentialBindingDaoDbImpl().listUsernames('private-api'),
    ).resolves.toEqual([]);
  });
});

test('conditional database writes reject a stale OAuth binding revision', async () => {
  const update = jest.fn().mockResolvedValueOnce({ affected: 0 }).mockResolvedValueOnce({ affected: 1 });
  Object.assign(mockRepository, { update });
  const dao = new CredentialBindingDaoDbImpl();
  const binding = { serverName: 'gitlab', username: 'alice', encryptedValues: 'new', updatedAt: new Date().toISOString() };
  expect(await dao.compareAndSave(binding, 'stale')).toBe(false);
  expect(await dao.compareAndSave(binding, 'current')).toBe(true);
  expect(update).toHaveBeenLastCalledWith({ serverName: 'gitlab', username: 'alice', encryptedValues: 'current' }, binding);
});

test('adopting a destination fingerprint is one conditional update on an unbound row', async () => {
  const update = jest
    .fn()
    .mockResolvedValueOnce({ affected: 1 })
    .mockResolvedValueOnce({ affected: 0 });
  Object.assign(mockRepository, { update });
  const dao = new CredentialBindingDaoDbImpl();
  expect(await dao.adoptDestinationFingerprint('gitlab', 'alice', 'cipher', 'v1:abc')).toBe(true);
  expect(await dao.adoptDestinationFingerprint('gitlab', 'alice', 'cipher', 'v1:def')).toBe(false);
  expect(update).toHaveBeenCalledWith(
    {
      serverName: 'gitlab',
      username: 'alice',
      encryptedValues: 'cipher',
      destinationFingerprint: IsNull(),
    },
    { destinationFingerprint: 'v1:abc' },
  );
});

test('saving a binding persists its destination fingerprint', async () => {
  const binding = {
    serverName: 'gitlab',
    username: 'alice',
    encryptedValues: 'cipher',
    updatedAt: new Date().toISOString(),
    destinationFingerprint: 'v1:abc',
  };
  await new CredentialBindingDaoDbImpl().save(binding);
  expect(mockRepository.upsert).toHaveBeenCalledWith(binding, ['serverName', 'username']);
});

test('stamping support reads unstamped rows and sets a server fingerprint in one update', async () => {
  const update = jest.fn().mockResolvedValue({ affected: 2 });
  const find = jest.fn().mockResolvedValue([{ serverName: 'gitlab', username: 'alice' }]);
  Object.assign(mockRepository, { update, find });
  const dao = new CredentialBindingDaoDbImpl();
  expect(await dao.listUnstamped()).toHaveLength(1);
  expect(find).toHaveBeenCalledWith({ where: { destinationFingerprint: IsNull() } });
  await dao.setServerFingerprint('gitlab', 'v1:orphaned');
  expect(update).toHaveBeenCalledWith({ serverName: 'gitlab' }, { destinationFingerprint: 'v1:orphaned' });
});
