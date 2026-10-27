import { jest } from '@jest/globals';
import type { SystemConfig } from '../../src/types/index.js';

type Row = {
  id: string;
  timestamp: Date;
  server: string;
  tool: string;
  duration: number;
  status: string;
  errorMessage?: string;
  statusCode?: string | null;
  clientKind?: string | null;
  clientId?: string | null;
  input?: string;
  output?: string;
};

const findUserHistory = jest.fn<(...args: any[]) => Promise<Row[]>>();
const purgeOlderThan = jest.fn<(...args: any[]) => Promise<{ removed: number; done: boolean }>>();
let activityDao:
  | { findUserHistory: typeof findUserHistory; purgeOlderThan: typeof purgeOlderThan }
  | undefined;
let clients: Array<{ id: string; kind: 'oauth' | 'key'; name: string; idle?: boolean }>;
let oauthClients: Record<string, { name: string }>;

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getActivityDao: () => activityDao,
  isActivityLoggingEnabled: () => activityDao !== undefined,
}));
jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({ get: async () => null }),
  getOAuthClientDao: () => ({ findByClientId: async (id: string) => oauthClients[id] ?? null }),
}));
jest.mock('../../src/services/connectedClientService.js', () => ({
  listConnectedClients: async () => clients,
}));

import {
  ACTIVITY_PURGE_BUDGET_MS,
  ACTIVITY_PURGE_FIRST_RUN_MS,
  ACTIVITY_PURGE_INTERVAL_MS,
  classifyActivity,
  decodeCursor,
  encodeCursor,
  listUserActivity,
  purgeExpiredActivity,
  resolveActivityRetentionDays,
  startActivityRetention,
  stopActivityRetention,
} from '../../src/services/workspaceActivityService.js';

const A1 = '00000000-0000-4000-8000-000000000001';
const A2 = '00000000-0000-4000-8000-000000000002';
const A3 = '00000000-0000-4000-8000-000000000003';
const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const on = (extra: object = {}): SystemConfig =>
  ({ workspace: { enabled: true, ...extra } }) as SystemConfig;

const row = (overrides: Partial<Row> = {}): Row => ({
  id: A1,
  timestamp: new Date(NOW - 1000),
  server: 'alpha',
  tool: 'ping',
  duration: 12,
  status: 'success',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  activityDao = { findUserHistory, purgeOlderThan };
  clients = [];
  oauthClients = {};
  findUserHistory.mockResolvedValue([]);
  purgeOlderThan.mockResolvedValue({ removed: 0, done: true });
});

describe('classifyActivity', () => {
  it('reports success without a reason', () => {
    expect(classifyActivity({ status: 'success' })).toEqual({ result: 'success' });
  });

  it.each(['not_selected', 'paused', 'maintenance', 'needs_auth', 'revoked'])(
    'reports a call stopped by status %s as blocked with that code, whatever the message says',
    (code) => {
      for (const errorMessage of [undefined, 'Credential-templated server tool call failed']) {
        expect(classifyActivity({ status: 'error', statusCode: code, errorMessage })).toEqual({
          result: 'blocked',
          reason: code,
        });
      }
    },
  );

  it('does not read blocked from message text, so upstream text cannot imitate it', () => {
    expect(
      classifyActivity({
        status: 'error',
        errorMessage: 'remote said no (reason: paused)',
        statusCode: null,
      }),
    ).toEqual({ result: 'error', reason: 'upstream_error' });
  });

  it('keeps MCPHub\u2019s own messages as fixed categories', () => {
    expect(
      classifyActivity({ status: 'error', errorMessage: 'Tool returned error response' }),
    ).toEqual({ result: 'error', reason: 'tool_error' });
    expect(
      classifyActivity({
        status: 'error',
        errorMessage: 'Credential-templated server tool call failed',
      }),
    ).toEqual({ result: 'error', reason: 'credential_server_error' });
  });

  it('treats other recorded codes as unavailable, and never echoes them', () => {
    const result = classifyActivity({ status: 'error', statusCode: 'server-hidden-from-caller' });
    expect(result).toEqual({ result: 'error', reason: 'unavailable' });
    expect(JSON.stringify(result)).not.toContain('hidden');
  });

  it('reports anything else, including upstream text, as a generic upstream error', () => {
    const leaky = 'connect ECONNREFUSED https://internal.example/mcp?token=sk-secret-123';
    const result = classifyActivity({ status: 'error', errorMessage: leaky });
    expect(result).toEqual({ result: 'error', reason: 'upstream_error' });
    expect(JSON.stringify(result)).not.toContain('sk-secret');
    expect(classifyActivity({ status: 'error' })).toEqual({
      result: 'error',
      reason: 'upstream_error',
    });
  });
});

describe('cursor', () => {
  it('round-trips and rejects garbage', () => {
    const cursor = encodeCursor({ timestamp: new Date(NOW), id: A1 });
    expect(decodeCursor(cursor)).toEqual({ timestamp: new Date(NOW), id: A1 });
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('rejects a cursor whose id is not a UUID', () => {
    for (const id of ['abc|def', "x' OR 1=1 --", 'a1', '']) {
      expect(decodeCursor(encodeCursor({ timestamp: new Date(NOW), id }))).toBeNull();
    }
  });
});

describe('resolveActivityRetentionDays', () => {
  it('defaults to 90 and ignores invalid values', () => {
    expect(resolveActivityRetentionDays(null)).toBe(90);
    expect(resolveActivityRetentionDays(on())).toBe(90);
    expect(resolveActivityRetentionDays(on({ activityRetentionDays: 30 }))).toBe(30);
    for (const bad of [0, -1, 1.5, 3651, '10']) {
      expect(resolveActivityRetentionDays(on({ activityRetentionDays: bad }))).toBe(90);
    }
  });
});

describe('listUserActivity', () => {
  const list = (options: Partial<Parameters<typeof listUserActivity>[1]> = {}) =>
    listUserActivity('alice', {
      filters: {},
      limit: 2,
      systemConfig: on(),
      now: NOW,
      ...options,
    });

  it('queries only the given user and never returns payloads or recorded error text', async () => {
    findUserHistory.mockResolvedValue([
      row({
        id: A1,
        status: 'error',
        errorMessage: 'GET https://api.example/v1?access_token=SECRET failed',
        input: '{"query":"private"}',
        output: '{"rows":["private"]}',
        clientKind: 'oauth',
        clientId: 'c1',
      }),
    ]);
    clients = [{ id: 'c1', kind: 'oauth', name: 'Claude Desktop' }];

    const page = await list();

    expect(findUserHistory).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }));
    const text = JSON.stringify(page);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('private');
    expect(text).not.toContain('errorMessage');
    expect(page.items[0]).toEqual({
      id: A1,
      timestamp: new Date(NOW - 1000).toISOString(),
      server: 'alpha',
      tool: 'ping',
      status: 'error',
      durationMs: 12,
      reason: 'upstream_error',
      client: { kind: 'oauth', id: 'c1', name: 'Claude Desktop', active: true },
    });
  });

  it('names gone clients: stored OAuth name when it survives, otherwise unknown', async () => {
    findUserHistory.mockResolvedValue([
      row({ id: A1, clientKind: 'oauth', clientId: 'gone-oauth' }),
      row({ id: A2, clientKind: 'key', clientId: 'gone-key' }),
      row({ id: A3, clientKind: null, clientId: null }),
    ]);
    oauthClients['gone-oauth'] = { name: 'Old app' };

    const { items } = await list({ limit: 5 });

    expect(items[0].client).toEqual({
      kind: 'oauth',
      id: 'gone-oauth',
      name: 'Old app',
      active: false,
    });
    expect(items[1].client).toEqual({ kind: 'key', id: 'gone-key', name: null, active: false });
    expect(items[2].client).toBeNull();
  });

  it('marks a client past the idle window as no longer active', async () => {
    findUserHistory.mockResolvedValue([row({ id: A1, clientKind: 'key', clientId: 'k1' })]);
    clients = [{ id: 'k1', kind: 'key', name: 'laptop', idle: true }];
    const { items } = await list();
    expect(items[0].client).toEqual({ kind: 'key', id: 'k1', name: 'laptop', active: false });
  });

  it('asks for one extra row and returns a cursor only when another page exists', async () => {
    findUserHistory.mockResolvedValue([row({ id: A3 }), row({ id: A2 }), row({ id: A1 })]);
    const first = await list({ limit: 2 });
    expect(findUserHistory).toHaveBeenCalledWith(expect.objectContaining({ limit: 3 }));
    expect(first.items.map((item) => item.id)).toEqual([A3, A2]);
    expect(decodeCursor(first.nextCursor!)).toEqual({
      timestamp: new Date(NOW - 1000),
      id: A2,
    });

    findUserHistory.mockResolvedValue([row({ id: A1 })]);
    const last = await list({ limit: 2, cursor: decodeCursor(first.nextCursor!)! });
    expect(last.nextCursor).toBeNull();
    expect(findUserHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ after: { timestamp: new Date(NOW - 1000), id: A2 } }),
    );
  });

  it('never looks past the retention window, however early since is', async () => {
    await list({
      systemConfig: on({ activityRetentionDays: 30 }),
      filters: { since: new Date(0) },
    });
    expect(findUserHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({ since: new Date(NOW - 30 * DAY) }),
    );

    const later = new Date(NOW - 2 * DAY);
    await list({ systemConfig: on({ activityRetentionDays: 30 }), filters: { since: later } });
    expect(findUserHistory).toHaveBeenLastCalledWith(expect.objectContaining({ since: later }));
  });

  it('passes the filters through', async () => {
    await list({
      filters: { server: 'alpha', status: 'blocked', clientId: 'c1', clientKind: 'oauth' },
    });
    expect(findUserHistory).toHaveBeenLastCalledWith(
      expect.objectContaining({
        server: 'alpha',
        status: 'blocked',
        clientId: 'c1',
        clientKind: 'oauth',
        blockedReasons: expect.arrayContaining(['paused', 'maintenance']),
      }),
    );
  });
});

describe('retention purge', () => {
  const adminOn = (days: number | undefined, extra: object = {}): SystemConfig =>
    ({
      ...(days === undefined ? {} : { activityLog: { retentionDays: days } }),
      workspace: { enabled: true, ...extra },
    }) as SystemConfig;
  const run = (config: SystemConfig | null) => purgeExpiredActivity(async () => config, NOW);

  beforeEach(() => purgeOlderThan.mockResolvedValue({ removed: 0, done: true }));

  it('deletes nothing when no administrator retention is set, with or without Workspace Mode', async () => {
    for (const config of [
      adminOn(undefined),
      adminOn(undefined, { activityRetentionDays: 5 }),
      { workspace: { enabled: false } } as SystemConfig,
      {} as SystemConfig,
      null,
      adminOn(0),
      adminOn(3651),
      { activityLog: { retentionDays: '30' } } as unknown as SystemConfig,
    ]) {
      expect(await run(config)).toEqual({ removed: 0, done: true });
    }
    expect(purgeOlderThan).not.toHaveBeenCalled();
  });

  it('deletes regardless of Workspace Mode once the administrator sets a retention', async () => {
    purgeOlderThan.mockResolvedValue({ removed: 7, done: true });
    const off = {
      activityLog: { retentionDays: 120 },
      workspace: { enabled: false },
    } as SystemConfig;
    expect(await run(off)).toEqual({ removed: 7, done: true });
    expect(purgeOlderThan).toHaveBeenCalledWith(new Date(NOW - 120 * DAY), expect.any(Object));
    await run({ activityLog: { retentionDays: 120 } } as SystemConfig);
    expect(purgeOlderThan).toHaveBeenCalledTimes(2);
  });

  it('never purges inside the window users can still see', async () => {
    await run(adminOn(30)); // view window defaults to 90
    expect(purgeOlderThan).toHaveBeenLastCalledWith(new Date(NOW - 90 * DAY), expect.any(Object));
    await run(adminOn(30, { activityRetentionDays: 45 }));
    expect(purgeOlderThan).toHaveBeenLastCalledWith(new Date(NOW - 45 * DAY), expect.any(Object));
    await run(adminOn(365, { activityRetentionDays: 45 }));
    expect(purgeOlderThan).toHaveBeenLastCalledWith(new Date(NOW - 365 * DAY), expect.any(Object));
  });

  it('does nothing without an activity store', async () => {
    activityDao = undefined;
    expect(await run(adminOn(365))).toEqual({ removed: 0, done: true });
  });

  it('passes a time budget so a run cannot go on indefinitely', async () => {
    await run(adminOn(365));
    expect(purgeOlderThan).toHaveBeenCalledWith(expect.any(Date), {
      budgetMs: ACTIVITY_PURGE_BUDGET_MS,
    });
  });

  describe('scheduler', () => {
    let config: SystemConfig | null;
    const read = jest.fn(async () => config);
    beforeEach(() => {
      jest.useFakeTimers().setSystemTime(NOW);
      config = adminOn(100);
      read.mockClear();
    });
    afterEach(() => {
      stopActivityRetention();
      jest.useRealTimers();
    });

    it('purges after the first delay and on every interval', async () => {
      startActivityRetention(read);
      startActivityRetention(read); // idempotent
      await jest.advanceTimersByTimeAsync(ACTIVITY_PURGE_FIRST_RUN_MS);
      expect(purgeOlderThan).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(ACTIVITY_PURGE_INTERVAL_MS);
      expect(purgeOlderThan).toHaveBeenCalledTimes(2);
    });

    it('reads the settings fresh on every run, not from a cache', async () => {
      startActivityRetention(read);
      await jest.advanceTimersByTimeAsync(ACTIVITY_PURGE_FIRST_RUN_MS);
      expect(read).toHaveBeenCalledTimes(1);

      config = adminOn(200);
      await jest.advanceTimersByTimeAsync(ACTIVITY_PURGE_INTERVAL_MS);
      expect(read).toHaveBeenCalledTimes(2);
      const cutoff = purgeOlderThan.mock.calls[1][0] as Date;
      expect(cutoff.getTime()).toBe(NOW + ACTIVITY_PURGE_INTERVAL_MS - 200 * DAY);
    });

    it('stops purging when the administrator removes the setting', async () => {
      startActivityRetention(read);
      await jest.advanceTimersByTimeAsync(ACTIVITY_PURGE_FIRST_RUN_MS);
      config = adminOn(undefined);
      await jest.advanceTimersByTimeAsync(ACTIVITY_PURGE_INTERVAL_MS * 3);
      expect(purgeOlderThan).toHaveBeenCalledTimes(1);
    });

    it('warns when a backlog remains, survives a failing run, and stops when asked', async () => {
      const { logger } = await import('../../src/utils/logger.js');
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
      purgeOlderThan.mockResolvedValueOnce({ removed: 5, done: false });
      purgeOlderThan.mockRejectedValueOnce(new Error('db down'));
      startActivityRetention(read);
      await jest.advanceTimersByTimeAsync(ACTIVITY_PURGE_FIRST_RUN_MS);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('backlog'));
      await jest.advanceTimersByTimeAsync(ACTIVITY_PURGE_INTERVAL_MS);
      expect(purgeOlderThan).toHaveBeenCalledTimes(2);

      stopActivityRetention();
      await jest.advanceTimersByTimeAsync(ACTIVITY_PURGE_INTERVAL_MS * 3);
      expect(purgeOlderThan).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('uses unref\u2019d timers so it never keeps the process alive', () => {
      const unref = jest.fn();
      const realSetInterval = global.setInterval;
      const spy = jest.spyOn(global, 'setInterval').mockImplementation(((
        fn: () => void,
        ms: number,
      ) => {
        const handle = realSetInterval(fn, ms);
        const originalUnref = handle.unref.bind(handle);
        handle.unref = () => {
          unref();
          return originalUnref();
        };
        return handle;
      }) as typeof setInterval);
      startActivityRetention(read);
      expect(unref).toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
