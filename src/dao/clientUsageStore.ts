import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getSettingsPath } from '../config/index.js';
import { getCachedSystemConfig } from '../utils/systemConfigCache.js';
import { logger } from '../utils/logger.js';

// JSON mode keeps credential last-use times in a sidecar next to the settings file so a usage
// stamp never rewrites mcp_settings.json. Entries are keyed by key id or by a digest of the
// access token; a raw credential is never stored. Database mode uses columns instead.

const file = (): string => `${getSettingsPath()}.usage.json`;

let cache: { file: string; entries: Record<string, string> } | null = null;

export const usageKeyForKey = (id: string): string => `key:${id}`;
export const usageKeyForToken = (accessToken: string): string =>
  `oauth:${createHash('sha256').update(accessToken).digest('hex')}`;

const load = (): Record<string, string> => {
  const target = file();
  if (cache?.file === target) return cache.entries;
  let entries: Record<string, string> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) entries = parsed;
  } catch {
    // Missing or unreadable: start empty. A broken sidecar must never block authentication.
  }
  cache = { file: target, entries };
  return entries;
};

const persist = (entries: Record<string, string>): void => {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(entries), { flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

const later = (a?: string, b?: string): string | undefined => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
};

// The sidecar only exists for Workspace Mode: with it off nothing is read or written, and a
// failure here (unwritable directory, full disk) never fails the credential operation it
// accompanies.
const isTracking = (): boolean => getCachedSystemConfig()?.workspace?.enabled === true;

const safely = <T>(action: string, fallback: T, run: () => T): T => {
  try {
    return run();
  } catch (error) {
    logger.warn(`Client usage sidecar: could not ${action}`, error);
    return fallback;
  }
};

/** The later of a record's own value and the sidecar's. */
export const mergeLastUsed = (
  recorded: string | undefined,
  usageKey: string,
): string | undefined =>
  isTracking() ? safely('read', recorded, () => later(recorded, load()[usageKey])) : recorded;

/** Returns whether the stamp was stored. */
export const recordUsage = (usageKey: string, at: string): boolean => {
  if (!isTracking()) return false;
  return safely('record last use', false, () => {
    const entries = load();
    const next = { ...entries, [usageKey]: later(entries[usageKey], at)! };
    persist(next);
    cache = { file: file(), entries: next };
    return true;
  });
};

/** Drop entries of `prefix` whose credential no longer exists. */
export const pruneUsage = (prefix: 'key:' | 'oauth:', liveKeys: Set<string>): void => {
  if (!isTracking()) return;
  safely('prune', undefined, () => {
    const entries = load();
    const stale = Object.keys(entries).filter(
      (key) => key.startsWith(prefix) && !liveKeys.has(key),
    );
    if (stale.length === 0) return;
    const next = { ...entries };
    for (const key of stale) delete next[key];
    persist(next);
    cache = { file: file(), entries: next };
  });
};

/** Test hook. */
export const resetUsageStoreCache = (): void => {
  cache = null;
};
