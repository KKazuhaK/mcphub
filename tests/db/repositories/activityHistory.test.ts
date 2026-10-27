// The TypeORM query builder is stood in for by a recorder: what matters is which columns are
// selected (never the payloads), the user condition, and the bounded purge.
const calls: Array<[string, ...unknown[]]> = [];
const qb: any = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === 'getMany') return async () => [];
      return (...args: unknown[]) => {
        calls.push([name, ...args]);
        return qb;
      };
    },
  },
);
const repository = {
  createQueryBuilder: jest.fn(() => qb),
  find: jest.fn(),
  delete: jest.fn(),
};

jest.mock('../../../src/db/connection.js', () => ({
  getAppDataSource: jest.fn(() => ({ getRepository: jest.fn(() => repository) })),
}));

import { ActivityRepository } from '../../../src/db/repositories/ActivityRepository.js';

beforeEach(() => {
  calls.length = 0;
  jest.clearAllMocks();
});

describe('ActivityRepository.findUserHistory', () => {
  it('selects metadata columns only and always filters on the user', async () => {
    await new ActivityRepository().findUserHistory({ username: 'alice', limit: 21 });

    const select = calls.find(([name]) => name === 'select')![1] as string[];
    expect(select).toEqual(expect.arrayContaining(['a.id', 'a.timestamp', 'a.server', 'a.tool']));
    expect(select.join(' ')).not.toMatch(/input|output|sourceIp/);
    expect(calls.find(([name]) => name === 'where')).toEqual([
      'where',
      'a.username = :username',
      { username: 'alice' },
    ]);
    expect(calls).toContainEqual(['take', 21]);
    expect(calls).toContainEqual(['orderBy', 'a.timestamp', 'DESC']);
    expect(calls).toContainEqual(['addOrderBy', 'a.id', 'DESC']);
  });

  it('filters blocked and error on the indexed statusCode column, never on message text', async () => {
    await new ActivityRepository().findUserHistory({
      username: 'alice',
      limit: 5,
      status: 'blocked',
      blockedReasons: ['paused', 'maintenance'],
    });
    expect(calls).toContainEqual([
      'andWhere',
      'a.statusCode IN (:...blockedCodes)',
      { blockedCodes: ['paused', 'maintenance'] },
    ]);

    calls.length = 0;
    await new ActivityRepository().findUserHistory({
      username: 'alice',
      limit: 5,
      status: 'error',
      blockedReasons: ['paused'],
    });
    const sql = JSON.stringify(calls.filter(([name]) => name.endsWith('Where')));
    expect(sql).toContain('a.statusCode IS NULL OR a.statusCode NOT IN');
    expect(sql).not.toMatch(/LIKE|errorMessage/);
  });

  it('selects the status code so rows can be classified', async () => {
    await new ActivityRepository().findUserHistory({ username: 'alice', limit: 1 });
    expect(calls.find(([name]) => name === 'select')![1]).toContain('a.statusCode');
  });
});

describe('ActivityRepository.purgeOlderThan', () => {
  const cutoff = new Date('2026-01-01T00:00:00.000Z');

  it('deletes by id in batches until none are left', async () => {
    repository.find
      .mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
      .mockResolvedValueOnce([{ id: 'c' }, { id: 'd' }])
      .mockResolvedValueOnce([{ id: 'e' }]);
    repository.delete.mockImplementation(async (ids: string[]) => ({ affected: ids.length }));
    const result = await new ActivityRepository().purgeOlderThan(cutoff, { batchSize: 2 });
    expect(result).toEqual({ removed: 5, done: true });
    expect(repository.delete).toHaveBeenNthCalledWith(1, ['a', 'b']);
  });

  it('stops at the time budget and reports the remaining backlog', async () => {
    repository.find.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    repository.delete.mockResolvedValue({ affected: 2 });
    let clock = 0;
    const result = await new ActivityRepository().purgeOlderThan(cutoff, {
      batchSize: 2,
      budgetMs: 20_000,
      now: () => (clock += 8_000),
    });
    expect(result).toEqual({ removed: 6, done: false });
    expect(repository.find).toHaveBeenCalledTimes(3);
  });

  it('handles nothing to delete', async () => {
    repository.find.mockResolvedValue([]);
    expect(await new ActivityRepository().purgeOlderThan(cutoff)).toEqual({
      removed: 0,
      done: true,
    });
    expect(repository.delete).not.toHaveBeenCalled();
  });
});
