import { createHash, randomBytes } from 'node:crypto';
import { safeCompare } from './safeCompare.js';

// Bearer keys are stored as a SHA-256 digest of the token plus a short display prefix. Tokens
// are 256-bit random values, so a plain digest is not brute-forceable; a keyed HMAC is not used
// because the only server secret (JWT_SECRET) is regenerated on every start when unset, which
// would invalidate every stored key.

export const BEARER_KEY_PREFIX_LENGTH = 8;

export const generateBearerToken = (): string => `mcphub_${randomBytes(32).toString('hex')}`;

export const hashBearerToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

// Legacy tokens can be short; never let the display prefix reveal most of one.
export const bearerTokenPrefix = (token: string): string =>
  token.slice(0, Math.min(BEARER_KEY_PREFIX_LENGTH, Math.floor(token.length / 3)));

export const describeBearerToken = (token: string): { tokenHash: string; tokenPrefix: string } => ({
  tokenHash: hashBearerToken(token),
  tokenPrefix: bearerTokenPrefix(token),
});

/** Constant-time comparison of a stored hash with the hash of a presented token. */
export const bearerHashMatches = (storedHash: string | undefined, presentedHash: string): boolean =>
  !!storedHash && safeCompare(storedHash, presentedHash);

/** The display form of a key: the prefix only, never enough to use the key. */
export const maskedBearerToken = (key: { tokenPrefix?: string }): string =>
  key.tokenPrefix ? `${key.tokenPrefix}...` : '********';
