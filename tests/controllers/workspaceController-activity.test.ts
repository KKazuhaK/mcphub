import express from 'express';
import request from 'supertest';

type Row = {
  id: string;
  username: string;
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
  sourceIp?: string;
};

let workspaceConfig: Record<string, unknown> | null;
let rows: Row[];
let daoAvailable: boolean;
const findUserHistory = jest.fn();

// Stands in for the SQL: a user filter, status/server/client filters, keyset order.
const fakeHistory = async (query: any): Promise<Row[]> => {
  findUserHistory(query);
  return rows
    .filter((r) => r.username === query.username)
    .filter((r) => !query.server || r.server === query.server)
    .filter((r) => !query.clientId || r.clientId === query.clientId)
    .filter((r) => !query.since || r.timestamp >= query.since)
    .filter((r) => !query.until || r.timestamp <= query.until)
    .filter((r) => {
      if (!query.status) return true;
      const blocked = (query.blockedReasons as string[]).includes(r.statusCode ?? '');
      if (query.status === 'success') return r.status === 'success';
      if (query.status === 'blocked') return r.status === 'error' && blocked;
      return r.status === 'error' && !blocked;
    })
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime() || (a.id < b.id ? 1 : -1))
    .filter(
      (r) =>
        !query.after ||
        r.timestamp < query.after.timestamp ||
        (r.timestamp.getTime() === query.after.timestamp.getTime() && r.id < query.after.id),
    )
    .slice(0, query.limit);
};

jest.mock('../../src/dao/DaoFactory.js', () => ({
  getGroupDao: () => ({}),
  getServerDao: () => ({}),
  getUserServerSelectionDao: () => ({}),
  getActivityDao: () => (daoAvailable ? { findUserHistory: fakeHistory } : undefined),
  isActivityLoggingEnabled: () => daoAvailable,
}));
jest.mock('../../src/dao/index.js', () => ({
  getOAuthClientDao: () => ({ findByClientId: async () => null }),
}));
jest.mock('../../src/services/connectedClientService.js', () => ({
  listConnectedClients: async (username: string) =>
    username === 'alice' ? [{ id: 'client-a', kind: 'oauth', name: 'Claude', idle: false }] : [],
}));
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: () => workspaceConfig,
  setCachedSystemConfig: jest.fn(),
  isDatabaseModeEnabled: () => false,
}));
jest.mock('../../src/config/index.js', () => ({
  getNameSeparator: () => '::',
  default: { basePath: '' },
}));
jest.mock('../../src/services/mcpService.js', () => ({}));
jest.mock('../../src/services/sseService.js', () => ({}));
jest.mock('../../src/services/credentialBindingService.js', () => ({}));
jest.mock('../../src/services/personalOAuthService.js', () => ({}));

import { listWorkspaceActivity } from '../../src/controllers/workspaceController.js';

const app = express();
app.use((req, _res, next) => {
  const header = req.headers['x-test-user'];
  if (typeof header === 'string') (req as any).user = JSON.parse(header);
  next();
});
app.get('/api/workspace/activity', listWorkspaceActivity);

const A1 = '00000000-0000-4000-8000-000000000001';
const A2 = '00000000-0000-4000-8000-000000000002';
const A3 = '00000000-0000-4000-8000-000000000003';
const A4 = '00000000-0000-4000-8000-000000000004';
const B1 = '00000000-0000-4000-8000-000000000005';
const OLD = '00000000-0000-4000-8000-000000000006';
const RECENT = '00000000-0000-4000-8000-000000000007';
const DAY_OLD = '00000000-0000-4000-8000-000000000008';

const as = (username: string, isAdmin = false) => JSON.stringify({ username, isAdmin });
const get = (query = '', user = as('alice')) =>
  request(app).get(`/api/workspace/activity${query}`).set('x-test-user', user);

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000);
const row = (overrides: Partial<Row>): Row => ({
  id: 'r',
  username: 'alice',
  timestamp: hoursAgo(1),
  server: 'alpha',
  tool: 'ping',
  duration: 5,
  status: 'success',
  clientKind: 'oauth',
  clientId: 'client-a',
  input: '{"q":"PRIVATE-INPUT"}',
  output: '{"r":"PRIVATE-OUTPUT"}',
  sourceIp: '203.0.113.9',
  ...overrides,
});

beforeEach(() => {
  workspaceConfig = { workspace: { enabled: true } };
  daoAvailable = true;
  findUserHistory.mockClear();
  rows = [
    row({ id: A1, timestamp: hoursAgo(1) }),
    row({
      id: A2,
      timestamp: hoursAgo(2),
      status: 'error',
      server: 'beta',
      errorMessage:
        'fetch https://api.example/v1/data?token=abc123SECRET failed: 401 {"detail":"x"}',
    }),
    row({
      id: A3,
      timestamp: hoursAgo(3),
      status: 'error',
      errorMessage: 'Credential-templated server tool call failed',
      statusCode: 'paused',
    }),
    row({ id: A4, timestamp: hoursAgo(4), clientKind: 'key', clientId: 'key-gone' }),
    row({ id: B1, username: 'bob', timestamp: hoursAgo(1), tool: 'bobs-tool' }),
    row({ id: OLD, timestamp: hoursAgo(24 * 100), tool: 'ancient' }),
  ];
});

describe('GET /api/workspace/activity', () => {
  it('answers 404 whenever the workspace is off, and 401 without a session', async () => {
    for (const cfg of [{}, { workspace: { enabled: false } }, null]) {
      workspaceConfig = cfg;
      const res = await get();
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, message: 'Not found' });
    }
    workspaceConfig = { workspace: { enabled: true } };
    expect((await request(app).get('/api/workspace/activity')).status).toBe(401);
  });

  it('reports history as unavailable outside database mode', async () => {
    daoAvailable = false;
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { available: false } });
  });

  it('returns only the caller’s rows within retention, ignoring any username parameter', async () => {
    const res = await get('?username=bob&user=bob', as('alice', true));
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.items.map((i: any) => i.id)).toEqual([A1, A2, A3, A4]);
    expect(findUserHistory).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice' }));

    const bob = await get('', as('bob'));
    expect(bob.body.data.items.map((i: any) => i.id)).toEqual([B1]);
  });

  it('never returns payloads, source address, or the recorded error text', async () => {
    const res = await get();
    const text = JSON.stringify(res.body);
    for (const leaked of [
      'PRIVATE-INPUT',
      'PRIVATE-OUTPUT',
      'abc123SECRET',
      'api.example',
      'detail',
      '203.0.113.9',
      'errorMessage',
      '"input"',
      '"output"',
      'sourceIp',
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it('classifies results and resolves client names', async () => {
    const { items } = (await get()).body.data;
    const byId = Object.fromEntries(items.map((i: any) => [i.id, i]));
    expect(byId[A1]).toMatchObject({
      status: 'success',
      server: 'alpha',
      tool: 'ping',
      durationMs: 5,
      client: { kind: 'oauth', id: 'client-a', name: 'Claude', active: true },
    });
    expect(byId[A1].reason).toBeUndefined();
    expect(byId[A2]).toMatchObject({ status: 'error', reason: 'upstream_error' });
    expect(byId[A3]).toMatchObject({ status: 'blocked', reason: 'paused' });
    expect(byId[A4].client).toEqual({ kind: 'key', id: 'key-gone', name: null, active: false });
  });

  it('filters by service, result and client', async () => {
    const ids = async (query: string) => (await get(query)).body.data.items.map((i: any) => i.id);
    expect(await ids('?server=beta')).toEqual([A2]);
    expect(await ids('?status=success')).toEqual([A1, A4]);
    expect(await ids('?status=error')).toEqual([A2]);
    expect(await ids('?status=blocked')).toEqual([A3]);
    expect(await ids('?clientId=key-gone&clientKind=key')).toEqual([A4]);
    const since = encodeURIComponent(hoursAgo(2.5).toISOString());
    expect(await ids(`?since=${since}`)).toEqual([A1, A2]);
    const until = encodeURIComponent(hoursAgo(2.5).toISOString());
    expect(await ids(`?until=${until}`)).toEqual([A3, A4]);
  });

  it('pages newest first with a cursor until the end', async () => {
    const first = (await get('?limit=3')).body.data;
    expect(first.items.map((i: any) => i.id)).toEqual([A1, A2, A3]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = (await get(`?limit=3&cursor=${first.nextCursor}`)).body.data;
    expect(second.items.map((i: any) => i.id)).toEqual([A4]);
    expect(second.nextCursor).toBeNull();
  });

  it('applies the configured retention window', async () => {
    workspaceConfig = { workspace: { enabled: true, activityRetentionDays: 1 } };
    rows.push(row({ id: DAY_OLD, timestamp: hoursAgo(30) }));
    rows.push(row({ id: RECENT, timestamp: new Date(Date.now() - 600_000) }));
    const ids = (await get()).body.data.items.map((i: any) => i.id);
    expect(ids).toEqual([RECENT, A1, A2, A3, A4]);
    expect(ids).not.toContain(DAY_OLD);
  });

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=abc',
    '?status=nope',
    '?clientKind=cookie',
    '?since=yesterday',
    '?until=nope',
    '?cursor=garbage',
    `?cursor=${Buffer.from(`${new Date().toISOString()}|1' OR '1'='1`).toString('base64url')}`,
  ])('rejects %s with 400', async (query) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
