import 'reflect-metadata';

const load = (skip: boolean) => {
  if (skip) process.env.MCPHUB_SKIP_ACTIVITY_INDEX = 'true';
  else delete process.env.MCPHUB_SKIP_ACTIVITY_INDEX;
  jest.resetModules();
  const { getMetadataArgsStorage: storage } = jest.requireActual('typeorm');
  storage().indices.length = 0;
  jest.requireActual('../../../src/db/entities/Activity.js');
  const target = jest.requireActual('../../../src/db/entities/Activity.js').Activity;
  return storage().indices.filter(
    (index: { name?: string; target: unknown }) => index.target === target,
  );
};

afterAll(() => {
  delete process.env.MCPHUB_SKIP_ACTIVITY_INDEX;
});

describe('Activity history indexes', () => {
  const named = (indices: any[]) =>
    Object.fromEntries(
      indices
        .filter((index) => index.name?.startsWith('IDX_activities_'))
        .map((index) => [index.name, index]),
    );

  it('declares both indexes by explicit name and lets synchronize manage them by default', () => {
    const indices = named(load(false));
    expect(Object.keys(indices).sort()).toEqual([
      'IDX_activities_username_status_code',
      'IDX_activities_username_timestamp',
    ]);
    expect(indices.IDX_activities_username_timestamp.columns).toEqual(['username', 'timestamp']);
    expect(indices.IDX_activities_username_status_code.columns).toEqual(['username', 'statusCode']);
    for (const index of Object.values(indices) as any[]) {
      expect(index.synchronize).not.toBe(false);
    }
  });

  it('keeps the same names but stops synchronize from creating or dropping them when skipped', () => {
    const indices = named(load(true));
    expect(Object.keys(indices).sort()).toEqual([
      'IDX_activities_username_status_code',
      'IDX_activities_username_timestamp',
    ]);
    for (const index of Object.values(indices) as any[]) {
      expect(index.synchronize).toBe(false);
    }
  });

  it('is unaffected for the older indexes in both modes', () => {
    for (const skip of [false, true]) {
      const all = load(skip);
      expect(all.some((index: any) => index.columns?.length === 1)).toBe(true);
    }
  });
});
