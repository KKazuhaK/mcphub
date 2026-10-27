// better-sqlite3 has no native build in this environment, so the TypeORM repository is stood
// in for by a mock. What matters is the statement shape: a targeted update() and no read-merge-save.
const repository = {
  update: jest.fn(),
  save: jest.fn(),
  merge: jest.fn(),
  findOne: jest.fn(),
};

jest.mock('../../../src/db/connection.js', () => ({
  getAppDataSource: jest.fn(() => ({ getRepository: jest.fn(() => repository) })),
}));

import { OAuthTokenRepository } from '../../../src/db/repositories/OAuthTokenRepository.js';
import { BearerKeyRepository } from '../../../src/db/repositories/BearerKeyRepository.js';

const at = new Date('2026-06-01T00:00:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
});

describe.each([
  [
    'OAuthTokenRepository',
    () => new OAuthTokenRepository(),
    'access-1',
    { accessToken: 'access-1' },
  ],
  ['BearerKeyRepository', () => new BearerKeyRepository(), 'key-1', { id: 'key-1' }],
])('%s.recordLastUsed', (_name, make, id, where) => {
  it('is a targeted UPDATE ... WHERE that never reads back or saves the row', async () => {
    repository.update.mockResolvedValue({ affected: 1 });
    expect(await make().recordLastUsed(id, at)).toBe(true);
    expect(repository.update).toHaveBeenCalledWith(where, { lastUsedAt: at });
    expect(repository.save).not.toHaveBeenCalled();
    expect(repository.merge).not.toHaveBeenCalled();
    expect(repository.findOne).not.toHaveBeenCalled();
  });

  it('affects nothing when the row was deleted meanwhile, so it cannot come back', async () => {
    repository.update.mockResolvedValue({ affected: 0 });
    expect(await make().recordLastUsed(id, at)).toBe(false);
    expect(repository.save).not.toHaveBeenCalled();
  });
});
