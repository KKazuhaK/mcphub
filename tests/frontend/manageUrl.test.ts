import { getManageUrlProblem, getSafeManageHref } from '../../frontend/src/utils/manageUrl';

describe('getManageUrlProblem', () => {
  it.each([
    '',
    '   ',
    'https://mcp.kazuhahub.com/ubc/',
    'http://localhost:3000/a',
    'http://127.0.0.1/a',
    'http://[::1]/a',
  ])('accepts %j', (value) => {
    expect(getManageUrlProblem(value)).toBeNull();
  });

  it.each([
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,x', 'scheme'],
    ['http://example.com/a', 'scheme'],
    ['/relative', 'invalid'],
    ['example.com', 'invalid'],
    ['https://user:pass@example.com/', 'credentials'],
    [`https://example.com/${'a'.repeat(2048)}`, 'tooLong'],
  ])('rejects %j as %s', (value, problem) => {
    expect(getManageUrlProblem(value)).toBe(problem);
  });
});

describe('getSafeManageHref', () => {
  it('returns a trimmed safe URL', () => {
    expect(getSafeManageHref(' https://example.com/a ')).toBe('https://example.com/a');
  });

  it.each([undefined, null, '', 'javascript:alert(1)', 'data:text/html,x', 'http://example.com'])(
    'returns nothing for %j',
    (value) => {
      expect(getSafeManageHref(value)).toBeUndefined();
    },
  );
});
