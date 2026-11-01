import { Request, Response } from 'express';

const mockFindAll = jest.fn();
const mockFindByOwner = jest.fn();
const mockFindById = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockDelete = jest.fn();
const mockFindUserByUsername = jest.fn();

jest.mock('../../src/dao/index.js', () => ({
  getBearerKeyDao: jest.fn(() => ({
    findAll: mockFindAll,
    findByOwner: mockFindByOwner,
    findById: mockFindById,
    create: mockCreate,
    update: mockUpdate,
    delete: mockDelete,
  })),
  getUserDao: jest.fn(() => ({
    findByUsername: mockFindUserByUsername,
  })),
}));

import {
  createBearerKey,
  deleteBearerKey,
  getBearerKeys,
  resetBearerKey,
  updateBearerKey,
} from '../../src/controllers/bearerKeyController.js';

const makeReq = (overrides: Record<string, unknown> = {}) =>
  ({
    body: {},
    params: {},
    user: { username: 'alice', isAdmin: false },
    ...overrides,
  }) as unknown as Request;

const makeRes = () => {
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  };
  return res as unknown as Response;
};

describe('bearerKeyController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists only the current user keys and masks tokens', async () => {
    mockFindByOwner.mockResolvedValue([
      {
        id: 'key-1',
        name: 'cursor',
        tokenHash: 'a'.repeat(64),
        tokenPrefix: 'mcphub_a',
        enabled: true,
        kind: 'user',
        owner: 'alice',
        accessType: 'all',
      },
    ]);
    const res = makeRes();

    await getBearerKeys(makeReq(), res);

    expect(mockFindByOwner).toHaveBeenCalledWith('alice');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: [
        expect.objectContaining({
          token: 'mcphub_a...',
          tokenPrefix: 'mcphub_a',
          kind: 'user',
          owner: 'alice',
        }),
      ],
    });
    // The hash never leaves the server.
    expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain('a'.repeat(64));
  });

  it('forces non-admin creation to a user-level key owned by the caller', async () => {
    mockFindUserByUsername.mockResolvedValue({ username: 'alice', isAdmin: false });
    mockCreate.mockImplementation(async (data) => ({ id: 'key-1', ...data }));
    const res = makeRes();

    await createBearerKey(
      makeReq({
        body: {
          name: 'cursor',
          kind: 'system',
          owner: 'bob',
          accessType: 'groups',
          allowedGroups: ['admins'],
        },
      }),
      res,
    );

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'cursor',
        kind: 'user',
        owner: 'alice',
        accessType: 'all',
        allowedGroups: [],
        allowedServers: [],
        token: expect.stringMatching(/^mcphub_[0-9a-f]{64}$/),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({ token: expect.stringMatching(/^mcphub_/) }),
      }),
    );
  });

  it('returns the plaintext token on create only, never the hash', async () => {
    mockFindUserByUsername.mockResolvedValue({ username: 'alice', isAdmin: false });
    mockCreate.mockImplementation(async (data) => ({
      id: 'key-9',
      ...data,
      tokenHash: 'c'.repeat(64),
      tokenPrefix: data.token.slice(0, 8),
    }));
    const createRes = makeRes();
    await createBearerKey(makeReq({ body: { name: 'cursor' } }), createRes);

    const created = (createRes.json as jest.Mock).mock.calls[0][0].data;
    expect(created.token).toMatch(/^mcphub_[0-9a-f]{64}$/);
    expect(created).not.toHaveProperty('tokenHash');

    // What the list returns afterwards is the prefix, whatever the DAO hands back.
    mockFindByOwner.mockResolvedValue([
      {
        id: 'key-9',
        name: 'cursor',
        tokenHash: 'c'.repeat(64),
        tokenPrefix: created.token.slice(0, 8),
        enabled: true,
        kind: 'user',
        owner: 'alice',
        accessType: 'all',
      },
    ]);
    const listRes = makeRes();
    await getBearerKeys(makeReq(), listRes);
    const listed = JSON.stringify((listRes.json as jest.Mock).mock.calls);
    expect(listed).toContain(created.token.slice(0, 8));
    expect(listed).not.toContain(created.token);
    expect(listed).not.toContain('c'.repeat(64));
  });

  it('does not allow a user to update another user key', async () => {
    mockFindById.mockResolvedValue({
      id: 'key-2',
      name: 'bob-key',
      token: 'secret',
      enabled: true,
      kind: 'user',
      owner: 'bob',
      accessType: 'all',
    });
    const res = makeRes();

    await updateBearerKey(makeReq({ params: { id: 'key-2' }, body: { enabled: false } }), res);

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('does not allow a user to delete another user key', async () => {
    mockFindById.mockResolvedValue({
      id: 'key-2',
      name: 'bob-key',
      token: 'secret',
      enabled: true,
      kind: 'user',
      owner: 'bob',
      accessType: 'all',
    });
    const res = makeRes();

    await deleteBearerKey(makeReq({ params: { id: 'key-2' } }), res);

    expect(mockDelete).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  describe('resetBearerKey', () => {
    const existing = {
      id: 'key-5',
      name: 'cursor',
      tokenHash: 'd'.repeat(64),
      tokenPrefix: 'mcphub_d',
      enabled: false,
      kind: 'user',
      owner: 'alice',
      accessType: 'all',
    };

    it('rotates only the secret and returns the new token once, without the hash', async () => {
      mockFindById.mockResolvedValue(existing);
      mockUpdate.mockImplementation(async (_id, data) => ({
        ...existing,
        tokenHash: 'e'.repeat(64),
        tokenPrefix: data.token.slice(0, 8),
      }));
      const res = makeRes();

      await resetBearerKey(makeReq({ params: { id: 'key-5' } }), res);

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      const [id, changes] = mockUpdate.mock.calls[0];
      expect(id).toBe('key-5');
      expect(Object.keys(changes)).toEqual(['token']);
      expect(changes.token).toMatch(/^mcphub_[0-9a-f]{64}$/);
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.data).toMatchObject({
        id: 'key-5',
        enabled: false,
        kind: 'user',
        owner: 'alice',
        token: changes.token,
      });
      expect(body.data).not.toHaveProperty('tokenHash');
    });

    it('does not let a user reset another user key or a system key', async () => {
      for (const key of [
        { ...existing, owner: 'bob' },
        { ...existing, kind: 'system', owner: undefined },
      ]) {
        mockFindById.mockResolvedValue(key);
        const res = makeRes();
        await resetBearerKey(makeReq({ params: { id: 'key-5' } }), res);
        expect(res.status).toHaveBeenCalledWith(403);
      }
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('lets an administrator reset any key and reports an unknown key as missing', async () => {
      mockFindById.mockResolvedValueOnce({ ...existing, owner: 'bob' });
      mockUpdate.mockResolvedValue({ ...existing, owner: 'bob' });
      const adminReq = makeReq({
        params: { id: 'key-5' },
        user: { username: 'root', isAdmin: true },
      });
      const ok = makeRes();
      await resetBearerKey(adminReq, ok);
      expect(mockUpdate).toHaveBeenCalledTimes(1);

      mockFindById.mockResolvedValueOnce(undefined);
      const missing = makeRes();
      await resetBearerKey(adminReq, missing);
      expect(missing.status).toHaveBeenCalledWith(404);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
