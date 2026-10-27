let routing: Record<string, unknown> = {};
const mockAuthorize = jest.fn();

jest.mock('../../src/services/oauthServerService.js', () => ({
  getOAuthServer: jest.fn(() => ({ authorize: mockAuthorize })),
  handleTokenRequest: jest.fn(),
  handleAuthenticateRequest: jest.fn(),
}));
jest.mock('../../src/models/OAuth.js', () => ({ findOAuthClientById: jest.fn() }));
jest.mock('../../src/services/betterAuthSession.js', () => ({
  resolveBetterAuthUser: jest.fn(async () => null),
}));
jest.mock('../../src/utils/frontendShell.js', () => ({ injectOAuthConsentShell: jest.fn() }));
jest.mock('../../src/utils/userSession.js', () => ({
  getUserSessionVersion: jest.fn(() => 'v1'),
  resolveJwtUser: jest.fn(async (token: string) =>
    token === 'session-jwt' ? { username: 'alice', password: '', isAdmin: false } : null,
  ),
}));
jest.mock('../../src/dao/index.js', () => ({
  getGroupDao: jest.fn(),
  getServerDao: jest.fn(() => ({ findById: jest.fn().mockResolvedValue(null) })),
  getSystemConfigDao: jest.fn(() => ({ get: async () => ({ routing }) })),
}));

import { getGroupDao } from '../../src/dao/index.js';
import { getAuthorize, postAuthorize } from '../../src/controllers/oauthServerController.js';
import { findOAuthClientById } from '../../src/models/OAuth.js';
import { injectOAuthConsentShell } from '../../src/utils/frontendShell.js';
import { buildOAuthReturnTarget } from '../../frontend/src/utils/oauthReturn.js';

const authorizeQuery = {
  client_id: 'trusted-client',
  redirect_uri: 'https://trusted.example.com/callback',
  response_type: 'code',
  scope: 'read',
  state: 'st',
};

const makeRes = () => {
  const res: any = {};
  for (const name of ['status', 'json', 'redirect', 'type', 'send']) {
    res[name] = jest.fn().mockReturnValue(res);
  }
  return res;
};
const makeReq = (overrides: Record<string, unknown> = {}) => ({
  query: { ...authorizeQuery },
  body: {},
  headers: {},
  header: (name: string) => (overrides.headers as Record<string, string> | undefined)?.[name],
  method: 'POST',
  originalUrl: '/oauth/authorize?client_id=trusted-client',
  t: (key: string) => key,
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  routing = {};
  (findOAuthClientById as jest.Mock).mockResolvedValue({
    clientId: 'trusted-client',
    name: 'Trusted',
    clientSecret: 'secret',
    redirectUris: ['https://trusted.example.com/callback'],
  });
  (injectOAuthConsentShell as jest.Mock).mockReturnValue('<html>shell</html>');
  (getGroupDao as jest.Mock).mockReturnValue({ findByName: jest.fn().mockResolvedValue(null) });
  mockAuthorize.mockResolvedValue({ authorizationCode: 'code-123' });
});

describe('OAuth consent with credentials in URLs refused (allowTokenInQuery=false)', () => {
  beforeEach(() => {
    routing = { allowTokenInQuery: false };
  });

  it('serves the consent shell for the headerless navigation instead of looping through login', async () => {
    const res = makeRes();
    await getAuthorize(makeReq() as any, res);

    expect(res.redirect).not.toHaveBeenCalled();
    const context = (injectOAuthConsentShell as jest.Mock).mock.calls[0][0];
    expect(context.needsSession).toBe(true);
    expect(context.token).toBeUndefined();
    expect(res.type).toHaveBeenCalledWith('html');
  });

  it('does not reveal what a resource name is before sign-in, and resolves it after', async () => {
    (getGroupDao as jest.Mock).mockReturnValue({
      findByName: jest.fn().mockResolvedValue({ name: 'secret-group' }),
    });
    const resource = 'https://hub.example.com/mcp/secret-group';

    const res = makeRes();
    await getAuthorize(makeReq({ query: { ...authorizeQuery, resource } }) as any, res);
    const context = (injectOAuthConsentShell as jest.Mock).mock.calls[0][0];
    expect(context.resource.kind).toBe('target');

    const followUp = makeRes();
    await getAuthorize(
      makeReq({
        query: { ...authorizeQuery, resource },
        headers: { accept: 'application/json', 'x-auth-token': 'session-jwt' },
      }) as any,
      followUp,
    );
    expect(followUp.json.mock.calls[0][0].resource).toMatchObject({
      kind: 'group',
      name: 'secret-group',
    });
    expect(injectOAuthConsentShell).toHaveBeenCalledTimes(1);
  });

  it('answers 401 to any credential in the consent URL', async () => {
    const res = makeRes();
    await getAuthorize(makeReq({ query: { ...authorizeQuery, token: 'session-jwt' } }) as any, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(injectOAuthConsentShell).not.toHaveBeenCalled();
  });

  it('answers 401 rather than looping when the dashboard shell is not deployed', async () => {
    (injectOAuthConsentShell as jest.Mock).mockReturnValue(null);
    const res = makeRes();
    await getAuthorize(makeReq() as any, res);

    expect(res.redirect).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('takes the decision from a header-authenticated fetch and returns the redirect as JSON', async () => {
    const res = makeRes();
    await postAuthorize(
      makeReq({
        headers: { accept: 'application/json', 'x-auth-token': 'session-jwt' },
        body: { ...authorizeQuery, allow: 'true' },
      }) as any,
      res,
    );

    expect(mockAuthorize).toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
    const { redirect } = res.json.mock.calls[0][0];
    expect(redirect).toContain('https://trusted.example.com/callback?code=code-123');
    expect(redirect).toContain('state=st');
  });

  it('keeps the 302 when the request has no session header, whatever it accepts', async () => {
    const res = makeRes();
    await postAuthorize(
      makeReq({
        headers: { accept: 'application/json' },
        body: { ...authorizeQuery, allow: 'false' },
      }) as any,
      res,
    );

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('error=access_denied'));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('rejects a decision with no session', async () => {
    const res = makeRes();
    await postAuthorize(
      makeReq({
        headers: { accept: 'application/json' },
        body: { ...authorizeQuery, allow: 'true' },
      }) as any,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('never builds a URL carrying the session token anywhere in the flow', async () => {
    // Login returns to the same authorize URL, token-free; that navigation is served the shell.
    const target = buildOAuthReturnTarget(
      '/oauth/authorize?client_id=trusted-client&token=stale',
      'https://hub.example.com',
    );
    expect(target).toBe('/oauth/authorize?client_id=trusted-client');
    expect(target).not.toContain('session-jwt');

    const res = makeRes();
    await getAuthorize(
      makeReq({
        originalUrl: target,
        query: {
          client_id: 'trusted-client',
          redirect_uri: authorizeQuery.redirect_uri,
          response_type: 'code',
        },
      }) as any,
      res,
    );
    expect(res.redirect).not.toHaveBeenCalled();
    expect(JSON.stringify((injectOAuthConsentShell as jest.Mock).mock.calls)).not.toContain(
      'session-jwt',
    );
  });
});

describe('OAuth consent with credentials in URLs allowed (default)', () => {
  it('serves the consent page for a headerless navigation instead of redirecting to login', async () => {
    const res = makeRes();
    await getAuthorize(makeReq() as any, res);

    expect(res.redirect).not.toHaveBeenCalled();
    const context = (injectOAuthConsentShell as jest.Mock).mock.calls[0][0];
    expect(context.needsSession).toBe(true);
    expect(context.token).toBeUndefined();
  });

  it('falls back to the login redirect when the dashboard is not deployed', async () => {
    (injectOAuthConsentShell as jest.Mock).mockReturnValue(null);
    const res = makeRes();
    await getAuthorize(makeReq() as any, res);

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/login?returnUrl='));
  });

  it('still honours ?token= on an existing external link', async () => {
    const res = makeRes();
    await getAuthorize(makeReq({ query: { ...authorizeQuery, token: 'session-jwt' } }) as any, res);

    const context = (injectOAuthConsentShell as jest.Mock).mock.calls[0][0];
    expect(context.token).toBe('session-jwt');
    expect(context.needsSession).toBeUndefined();
    expect(res.status).not.toHaveBeenCalledWith(401);
  });

  it('resolves the resource after sign-in and takes the decision from the stored session', async () => {
    const followUp = makeRes();
    await getAuthorize(
      makeReq({ headers: { accept: 'application/json', 'x-auth-token': 'session-jwt' } }) as any,
      followUp,
    );
    expect(followUp.json).toHaveBeenCalled();

    const res = makeRes();
    await postAuthorize(
      makeReq({
        headers: { accept: 'application/json', 'x-auth-token': 'session-jwt' },
        body: { ...authorizeQuery, allow: 'true' },
      }) as any,
      res,
    );
    expect(res.json.mock.calls[0][0].redirect).toContain('code=code-123');
  });

  it('a form post still gets a redirect, not JSON', async () => {
    const res = makeRes();
    await postAuthorize(
      makeReq({
        headers: { 'x-auth-token': 'session-jwt' },
        body: { ...authorizeQuery, allow: 'true' },
      }) as any,
      res,
    );

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('code=code-123'));
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('login return target is the same, token-free, in both settings', () => {
  it.each([true, false])(
    'never carries a credential (allowTokenInQuery=%s, public-config lookup irrelevant)',
    async (allow) => {
      routing = { allowTokenInQuery: allow };
      const target = buildOAuthReturnTarget(
        '/oauth/authorize?client_id=trusted-client&token=old',
        'https://hub.example.com',
      );
      expect(target).toBe('/oauth/authorize?client_id=trusted-client');

      // Landing there with no credential neither redirects to login (no loop) nor 401s on
      // the first visit; the SPA then supplies the session.
      const res = makeRes();
      await getAuthorize(
        makeReq({
          originalUrl: target,
          query: {
            client_id: 'trusted-client',
            redirect_uri: authorizeQuery.redirect_uri,
            response_type: 'code',
          },
        }) as any,
        res,
      );
      expect(res.redirect).not.toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalledWith(401);
      expect((injectOAuthConsentShell as jest.Mock).mock.calls[0][0].needsSession).toBe(true);
      expect(JSON.stringify((injectOAuthConsentShell as jest.Mock).mock.calls)).not.toContain(
        'session-jwt',
      );
    },
  );
});
