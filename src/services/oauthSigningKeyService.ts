import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
} from 'jose';
import type { CryptoKey, JWK, KeyObject } from 'jose';
import { getSettingsPath } from '../config/index.js';
import { getSystemConfigDao } from '../dao/index.js';
import { getAppDataSource } from '../db/connection.js';
import { OAuthSigningKey } from '../db/entities/OAuthSigningKey.js';
import { isDatabaseModeEnabled } from '../utils/systemConfigCache.js';
import { logger } from '../utils/logger.js';
import {
  openSecretWithCredentialKey,
  sealSecretWithCredentialKey,
} from './credentialBindingService.js';

/**
 * Signing keys for the JWT access tokens MCPHub issues for external resources (ADR 0014).
 *
 * ES256 (P-256), generated on first need and persisted: a 0600 sidecar next to the settings file
 * in JSON mode, the `oauth_signing_keys` table in database mode. The private key is sealed with
 * the credential encryption key when one can be read or created; otherwise it is stored as is
 * (with a warning) so the feature still works on a read-only deployment. The newest key that is
 * not retired signs; every key stays published until the tokens it could have signed have expired.
 * Private key material exists only here: no API, export or log line carries it.
 */

const ALG = 'ES256';
const CACHE_MS = 10_000;
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 3600;
// Clock-skew allowance added to a retired key's publication window.
const SKEW_MS = 5 * 60 * 1000;

export interface StoredSigningKey {
  kid: string;
  publicJwk: Record<string, unknown>;
  // `enc:<sealed>`: the PKCS#8 key sealed with the credential encryption key. Never plain.
  privateKey: string;
  createdAt: string;
  // The key may sign from this time on; it is published from `createdAt`. Absent = immediately.
  activateAt?: string | null;
  retiredAt?: string | null;
}

interface KeyStore {
  list(): Promise<StoredSigningKey[]>;
  save(key: StoredSigningKey): Promise<void>;
  remove(kid: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const sidecarPath = (): string => `${getSettingsPath()}.oauth-signing-keys.json`;

const jsonStore: KeyStore = {
  async list() {
    try {
      const parsed = JSON.parse(fs.readFileSync(sidecarPath(), 'utf8'));
      return Array.isArray(parsed?.keys) ? (parsed.keys as StoredSigningKey[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('Unable to read the OAuth signing key file', { cause: error });
    }
  },
  async save(key) {
    const keys = (await this.list()).filter((existing) => existing.kid !== key.kid);
    keys.push(key);
    writeSidecar(keys);
  },
  async remove(kid) {
    const keys = await this.list();
    const remaining = keys.filter((key) => key.kid !== kid);
    if (remaining.length !== keys.length) writeSidecar(remaining);
  },
};

const writeSidecar = (keys: StoredSigningKey[]): void => {
  const target = sidecarPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, keys }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

const databaseStore: KeyStore = {
  async list() {
    const rows = await getAppDataSource().getRepository(OAuthSigningKey).find();
    return rows.map((row) => ({
      kid: row.kid,
      publicJwk: row.publicJwk,
      privateKey: row.privateKey,
      createdAt: row.createdAt,
      activateAt: row.activateAt ?? null,
      retiredAt: row.retiredAt ?? null,
    }));
  },
  async save(key) {
    await getAppDataSource().getRepository(OAuthSigningKey).save(key);
  },
  async remove(kid) {
    await getAppDataSource().getRepository(OAuthSigningKey).delete({ kid });
  },
};

const store = (): KeyStore => (isDatabaseModeEnabled() ? databaseStore : jsonStore);

// ---------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------

const keyAad = (kid: string): string => `oauth-signing-key:${kid}`;

// Fails closed: when the credential encryption key cannot be read or created (a key is configured
// but invalid, or bindings exist and the key is lost) no signing key is generated or stored.
const sealPrivateKey = async (kid: string, pem: string): Promise<string> =>
  `enc:${await sealSecretWithCredentialKey(keyAad(kid), pem)}`;

const unsealPrivateKey = async (stored: StoredSigningKey): Promise<string> => {
  if (!stored.privateKey.startsWith('enc:')) throw new Error('Unknown signing key format');
  return openSecretWithCredentialKey(keyAad(stored.kid), stored.privateKey.slice('enc:'.length));
};

// Only these members of a public key are ever published; `d` can never be among them.
const toPublicJwk = (stored: StoredSigningKey): JWK => {
  const jwk = stored.publicJwk as Record<string, string>;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid: stored.kid, alg: ALG, use: 'sig' };
};

const generateKey = async (activateAt: Date): Promise<StoredSigningKey> => {
  const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  const pem = await exportPKCS8(privateKey);
  return {
    kid,
    publicJwk: { kty: 'EC', crv: 'P-256', x: publicJwk.x, y: publicJwk.y },
    privateKey: await sealPrivateKey(kid, pem),
    createdAt: new Date().toISOString(),
    activateAt: activateAt.toISOString(),
    retiredAt: null,
  };
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Signing is not possible and no replacement is generated here; an administrator must rotate. */
export class SigningKeyUnavailableError extends Error {}

const DEFAULT_ACTIVATION_DELAY_SECONDS = 900;
// After a failed first-time generation, further attempts wait this long.
const GENERATION_BACKOFF_MS = 60_000;

let cache: { at: number; keys: StoredSigningKey[] } | null = null;
const privateKeys = new Map<string, CryptoKey | KeyObject>();
let queue: Promise<unknown> = Promise.resolve();
let generationFailedAt = 0;

/** Serialise lifecycle changes within this process. */
const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
};

const listKeys = async (fresh = false): Promise<StoredSigningKey[]> => {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.keys;
  const keys = await store().list();
  cache = { at: Date.now(), keys };
  return keys;
};

const invalidate = (): void => {
  cache = null;
};

/** Test hook: forget everything held in memory (storage is untouched). */
export const resetSigningKeyCache = (): void => {
  cache = null;
  privateKeys.clear();
  generationFailedAt = 0;
};

const oauthSettings = async () => {
  try {
    return (await getSystemConfigDao().get())?.oauthServer;
  } catch {
    return undefined;
  }
};

const publishWindowMs = async (): Promise<number> => {
  const lifetime =
    (await oauthSettings())?.accessTokenLifetime || DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;
  return lifetime * 1000 + SKEW_MS;
};

const activationDelayMs = async (): Promise<number> => {
  const seconds = (await oauthSettings())?.signingKeyActivationDelaySeconds;
  return (
    (typeof seconds === 'number' && seconds >= 0 ? seconds : DEFAULT_ACTIVATION_DELAY_SECONDS) *
    1000
  );
};

const isPublished = (key: StoredSigningKey, windowMs: number, now: number): boolean =>
  !key.retiredAt || Date.parse(key.retiredAt) + windowMs > now;

const isActive = (key: StoredSigningKey, now: number): boolean =>
  !key.retiredAt && (!key.activateAt || Date.parse(key.activateAt) <= now);

const activatedAt = (key: StoredSigningKey): number => Date.parse(key.activateAt ?? key.createdAt);

const newest = (keys: StoredSigningKey[]): StoredSigningKey[] =>
  [...keys].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

const loadPrivateKey = async (stored: StoredSigningKey): Promise<CryptoKey | KeyObject | null> => {
  const cached = privateKeys.get(stored.kid);
  if (cached) return cached;
  try {
    const key = await importPKCS8(await unsealPrivateKey(stored), ALG);
    privateKeys.set(stored.kid, key);
    return key;
  } catch {
    return null;
  }
};

/**
 * The key that signs now: the newest key whose activation time has passed. Older active keys are
 * retired lazily when a newer one takes over (the pre-published key of a rotation). Never creates
 * or retires anything because a key cannot be unlocked.
 */
const currentKey = async (): Promise<{ stored: StoredSigningKey; key: CryptoKey | KeyObject }> => {
  const now = Date.now();
  const active = [...(await listKeys())]
    .filter((key) => isActive(key, now))
    .sort((a, b) => activatedAt(b) - activatedAt(a));
  if (active.length === 0) {
    throw new SigningKeyUnavailableError('No OAuth signing key is active');
  }
  const [stored, ...superseded] = active;
  const key = await loadPrivateKey(stored);
  if (!key) {
    logger.error(
      `The OAuth signing key ${stored.kid} cannot be unlocked (credential encryption key missing or changed); external-resource tokens are refused until an administrator rotates the signing key. Public keys stay published.`,
    );
    throw new SigningKeyUnavailableError('The current OAuth signing key cannot be unlocked');
  }
  if (superseded.length > 0) {
    await exclusive(async () => {
      for (const old of superseded) {
        await store().save({ ...old, retiredAt: new Date(activatedAt(stored)).toISOString() });
      }
      invalidate();
    });
  }
  return { stored, key };
};

/**
 * Create the very first key, once. Only called when no key exists at all; single-flight within the
 * process, and a failure (for example an unusable encryption key) is not retried for a minute so
 * unauthenticated JWKS requests cannot make it a loop.
 */
const createFirstKey = (): Promise<boolean> =>
  exclusive(async () => {
    if ((await listKeys(true)).length > 0) return true;
    if (Date.now() - generationFailedAt < GENERATION_BACKOFF_MS) return false;
    try {
      const created = await generateKey(new Date());
      await store().save(created);
      invalidate();
      logger.log(`Created OAuth signing key ${created.kid}`);
      return true;
    } catch (error) {
      generationFailedAt = Date.now();
      logger.error(
        'Unable to create an OAuth signing key (is the credential encryption key usable?)',
        error,
      );
      return false;
    }
  });

/**
 * Make sure a first signing key exists, so the JWKS a verifier fetches before the first token
 * already contains the key that will sign it. Does nothing when any key exists.
 */
export const ensureSigningKeyExists = async (): Promise<void> => {
  if ((await listKeys()).length > 0) return;
  await createFirstKey();
};

/** The published public keys: every non-retired key (pending ones too) and each retired one until its tokens expired. */
export const getPublicJwks = async (): Promise<{ keys: JWK[] }> => {
  const windowMs = await publishWindowMs();
  const now = Date.now();
  return {
    keys: newest(await listKeys())
      .filter((key) => isPublished(key, windowMs, now))
      .map(toPublicJwk),
  };
};

export interface ExternalAccessTokenClaims {
  issuer: string;
  audience: string;
  subject: string;
  clientId: string;
  scope: string;
  jti: string;
  expiresAt: Date;
}

/** Sign an RFC 9068 access token: `typ: at+jwt`, ES256, the current key's `kid`. */
export const signExternalAccessToken = async (
  claims: ExternalAccessTokenClaims,
): Promise<string> => {
  if ((await listKeys()).length === 0 && !(await createFirstKey())) {
    throw new SigningKeyUnavailableError('No OAuth signing key could be created');
  }
  const { stored, key } = await currentKey();
  return new SignJWT({ client_id: claims.clientId, scope: claims.scope })
    .setProtectedHeader({ alg: ALG, kid: stored.kid, typ: 'at+jwt' })
    .setIssuer(claims.issuer)
    .setAudience(claims.audience)
    .setSubject(claims.subject)
    .setIssuedAt()
    .setExpirationTime(Math.floor(claims.expiresAt.getTime() / 1000))
    .setJti(claims.jti)
    .sign(key);
};

/**
 * Explicit administrator rotation, and the only way a replacement key is ever generated. The new
 * key is published at once but starts signing only after `signingKeyActivationDelaySeconds`
 * (default 900), so verifiers' cached JWKS sets learn it first. Until then the current key keeps
 * signing; once it activates the older key is retired and stays published until the tokens it
 * signed have expired. A key that never activated is replaced by the new one. Returns key ids only.
 */
export const rotateSigningKey = (): Promise<{
  kid: string;
  activatesAt: string;
  retired: string[];
  removed: string[];
}> =>
  exclusive(async () => {
    const windowMs = await publishWindowMs();
    const now = Date.now();
    const keys = await listKeys(true);
    // A usable current key keeps signing during the delay; with none (first key, or the current
    // one cannot be unlocked) the new key must sign at once.
    const current = newest(keys.filter((key) => isActive(key, now)))[0];
    const delayMs = current && (await loadPrivateKey(current)) ? await activationDelayMs() : 0;
    const created = await generateKey(new Date(now + delayMs));
    await store().save(created);

    const removed: string[] = [];
    for (const key of keys) {
      const neverActivated = !key.retiredAt && key.activateAt && Date.parse(key.activateAt) > now;
      const expired = key.retiredAt && !isPublished(key, windowMs, now);
      if (neverActivated || expired) {
        await store().remove(key.kid);
        privateKeys.delete(key.kid);
        removed.push(key.kid);
      }
    }
    // A new key that signs at once replaces what is current.
    const retired: string[] = [];
    if (delayMs === 0) {
      for (const key of keys.filter(
        (candidate) => !candidate.retiredAt && !removed.includes(candidate.kid),
      )) {
        await store().save({ ...key, retiredAt: new Date(now).toISOString() });
        retired.push(key.kid);
      }
    }
    invalidate();
    logger.log(`Rotated OAuth signing key: ${created.kid} signs from ${created.activateAt}`);
    return { kid: created.kid, activatesAt: created.activateAt!, retired, removed };
  });
