import type { NextFunction, Request, Response } from 'express';

let routing: Record<string, unknown> = {};
let cachedConfig: { routing: Record<string, unknown> } | null = null;
const daoGet = jest.fn(async () => ({ routing }));

jest.mock('../../src/dao/index.js', () => ({
  getSystemConfigDao: () => ({ get: daoGet }),
}));
jest.mock('../../src/utils/systemConfigCache.js', () => ({
  getCachedSystemConfig: () => cachedConfig,
}));
jest.mock('../../src/utils/userSession.js', () => ({
  resolveJwtUser: jest.fn(async (token: string) =>
    token === 'valid-jwt' ? { username: 'alice', password: '', isAdmin: false } : null,
  ),
}));
jest.mock('../../src/utils/oauthBearer.js', () => ({
  resolveOAuthUserFromHeaders: jest.fn(async () => null),
}));

import { sseUserContextMiddleware } from '../../src/middlewares/userContext.js';

const run = async (query: Record<string, string>, headers: Record<string, string> = {}) => {
  const req = {
    params: { user: 'alice' },
    query,
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  await sseUserContextMiddleware(req, res, next);
  // The middleware continues inside runWithContext; let that settle.
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { res, next };
};

describe('sseUserContextMiddleware and credentials in the URL', () => {
  afterEach(() => {
    routing = {};
    cachedConfig = null;
    daoGet.mockClear();
  });

  it('reads the cached system config for the check, not the DAO', async () => {
    cachedConfig = { routing: { allowTokenInQuery: false } };

    const { res, next } = await run({ token: 'valid-jwt' });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(daoGet).not.toHaveBeenCalled();
  });

  it('accepts ?token= on user-scoped routes by default', async () => {
    const { res, next } = await run({ token: 'valid-jwt' });

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects ?token= on user-scoped routes when allowTokenInQuery is false', async () => {
    routing = { allowTokenInQuery: false };

    const { res, next } = await run({ token: 'valid-jwt' });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('still accepts the x-auth-token header when allowTokenInQuery is false', async () => {
    routing = { allowTokenInQuery: false };

    const { res, next } = await run({}, { 'x-auth-token': 'valid-jwt' });

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
