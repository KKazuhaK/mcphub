import { getUserDao } from '../dao/index.js';
import { logger } from '../utils/logger.js';

// Tool annotations are claims made by the upstream server. Under Workspace Mode they are only
// believed for servers an administrator owns; a server owned by anyone else could declare its
// tools read-only to slip past a user's ceiling, so all its tools count as `external`.
//
// The lookup is cached because the gate that needs it is synchronous. Async entry points call
// `primeAnnotationTrust()` first; a cold or failed cache trusts nobody (fail closed). A server
// with no owner is the default administrator's.
const TTL_MS = 5000;
let admins = new Set<string>();
let expiresAt = 0;
let loading: Promise<void> | undefined;

export const primeAnnotationTrust = async (): Promise<void> => {
  if (expiresAt > Date.now()) return;
  loading ??= (async () => {
    try {
      const users = await getUserDao().findAll();
      admins = new Set(users.filter((user) => user.isAdmin).map((user) => user.username));
      expiresAt = Date.now() + TTL_MS;
    } catch (error) {
      logger.warn('Failed to read users for annotation trust', { error });
      admins = new Set();
    } finally {
      loading = undefined;
    }
  })();
  await loading;
};

/** Whether the annotations of a server with this owner are believed. Needs a primed cache. */
export const areAnnotationsTrusted = (owner: string | undefined | null): boolean =>
  !owner || admins.has(owner);

export const clearAnnotationTrustCache = (): void => {
  admins = new Set();
  expiresAt = 0;
};
