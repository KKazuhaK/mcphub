import {
  getLoginRedirectPath,
  getServiceLinkHref,
  getServiceLinkPath,
} from '../../frontend/src/utils/serviceLink';
import { getManageUrlSubmitProblem } from '../../frontend/src/utils/manageUrl';

describe('service link helpers', () => {
  it('encodes the service name in the stable path', () => {
    expect(getServiceLinkPath('ubc-personal')).toBe('/services/ubc-personal');
    expect(getServiceLinkPath('a b/c')).toBe('/services/a%20b%2Fc');
    expect(getServiceLinkHref('ubc-personal')).toBe('/services/ubc-personal');
  });

  it('sends a signed-out visitor of a service link to login and back', () => {
    const target = getLoginRedirectPath('/services/ubc-personal');
    expect(target).toBe('/login?returnUrl=%2Fservices%2Fubc-personal');
    expect(new URLSearchParams(target.split('?')[1]).get('returnUrl')).toBe(
      '/services/ubc-personal',
    );
  });

  it('keeps the plain login redirect for every other path', () => {
    expect(getLoginRedirectPath('/servers')).toBe('/login');
    expect(getLoginRedirectPath('/')).toBe('/login');
  });
});

describe('getManageUrlSubmitProblem', () => {
  it('reports the problem to an administrator submitting a bad link', () => {
    expect(getManageUrlSubmitProblem('javascript:alert(1)', true)).toBe('scheme');
    expect(getManageUrlSubmitProblem('http://example.com', true)).toBe('scheme');
    expect(getManageUrlSubmitProblem('https://u:p@example.com', true)).toBe('credentials');
  });

  it('accepts a good link or a blank one', () => {
    expect(getManageUrlSubmitProblem('https://example.com/a', true)).toBeNull();
    expect(getManageUrlSubmitProblem('   ', true)).toBeNull();
    expect(getManageUrlSubmitProblem(undefined, true)).toBeNull();
  });

  it('checks nothing for a non-admin, whose form has no such field', () => {
    expect(getManageUrlSubmitProblem('javascript:alert(1)', false)).toBeNull();
  });
});

describe('service link helpers under a base path', () => {
  const g = globalThis as unknown as { window?: unknown };
  const before = g.window;

  beforeAll(() => {
    g.window = { __MCPHUB_CONFIG__: { basePath: 'hub', version: 'x', name: 'mcphub' } };
  });
  afterAll(() => {
    if (before === undefined) delete g.window;
    else g.window = before;
  });

  it('prefixes the href with the base path', () => {
    expect(getServiceLinkHref('ubc-personal')).toBe('/hub/services/ubc-personal');
    expect(getServiceLinkHref('a b')).toBe('/hub/services/a%20b');
  });

  it('returns to the base-path URL after login', () => {
    const target = getLoginRedirectPath('/services/ubc-personal', '?x=1');
    expect(new URLSearchParams(target.split('?')[1]).get('returnUrl')).toBe(
      '/hub/services/ubc-personal?x=1',
    );
    expect(getLoginRedirectPath('/servers')).toBe('/login');
  });
});
