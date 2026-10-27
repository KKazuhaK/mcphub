const mockFindAll = jest.fn();
jest.mock('../../src/dao/index.js', () => ({ getUserDao: () => ({ findAll: mockFindAll }) }));

import {
  areAnnotationsTrusted,
  clearAnnotationTrustCache,
  primeAnnotationTrust,
} from '../../src/services/annotationTrustService.js';

describe('annotation trust', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAnnotationTrustCache();
    mockFindAll.mockResolvedValue([
      { username: 'root', isAdmin: true },
      { username: 'alice', isAdmin: false },
    ]);
  });

  it('trusts servers an administrator owns, and servers with no owner', async () => {
    await primeAnnotationTrust();
    expect(areAnnotationsTrusted('root')).toBe(true);
    expect(areAnnotationsTrusted(undefined)).toBe(true);
    expect(areAnnotationsTrusted('')).toBe(true);
  });

  it('does not trust a non-admin owner or one that no longer exists', async () => {
    await primeAnnotationTrust();
    expect(areAnnotationsTrusted('alice')).toBe(false);
    expect(areAnnotationsTrusted('deleted-user')).toBe(false);
  });

  it('trusts nobody with an owner before the cache is primed, or when users cannot be read', () => {
    expect(areAnnotationsTrusted('root')).toBe(false);
    clearAnnotationTrustCache();
    mockFindAll.mockRejectedValue(new Error('db down'));
    return primeAnnotationTrust().then(() => {
      expect(areAnnotationsTrusted('root')).toBe(false);
      expect(areAnnotationsTrusted(undefined)).toBe(true);
    });
  });

  it('reads users once per window and notices a promotion afterwards', async () => {
    await primeAnnotationTrust();
    await primeAnnotationTrust();
    expect(mockFindAll).toHaveBeenCalledTimes(1);

    clearAnnotationTrustCache();
    mockFindAll.mockResolvedValue([{ username: 'alice', isAdmin: true }]);
    await primeAnnotationTrust();
    expect(areAnnotationsTrusted('alice')).toBe(true);
    expect(areAnnotationsTrusted('root')).toBe(false);
  });

  it('shares one read between concurrent callers', async () => {
    await Promise.all([primeAnnotationTrust(), primeAnnotationTrust(), primeAnnotationTrust()]);
    expect(mockFindAll).toHaveBeenCalledTimes(1);
  });
});
