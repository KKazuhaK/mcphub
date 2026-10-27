import { randomUUID } from 'node:crypto';
import { BearerKey } from '../types/index.js';
import { JsonFileBaseDao } from './base/JsonFileBaseDao.js';
import { bearerHashMatches, describeBearerToken, hashBearerToken } from '../utils/bearerKeyHash.js';
import { logger } from '../utils/logger.js';
import { summarizeErrorForLogging } from '../utils/serialization.js';
import { mergeLastUsed, pruneUsage, recordUsage, usageKeyForKey } from './clientUsageStore.js';

/**
 * DAO interface for bearer authentication keys
 */
export interface BearerKeyDao {
  findAll(): Promise<BearerKey[]>;
  findEnabled(): Promise<BearerKey[]>;
  findById(id: string): Promise<BearerKey | undefined>;
  /** Looks a presented token up by its hash. Returned keys never carry the plaintext. */
  findByToken(token: string): Promise<BearerKey | undefined>;
  findByOwner(owner: string): Promise<BearerKey[]>;
  /**
   * Takes the plaintext in `data.token`, stores only its hash and prefix, and returns the key
   * with the plaintext attached: the one time the caller can show it.
   */
  create(data: Omit<BearerKey, 'id'>): Promise<BearerKey>;
  update(id: string, data: Partial<Omit<BearerKey, 'id'>>): Promise<BearerKey | null>;
  delete(id: string): Promise<boolean>;
  deleteByOwner(owner: string): Promise<number>;
  /** A targeted last-use write: it never recreates a deleted key or changes another field. */
  recordLastUsed(id: string, at: string): Promise<void>;
  /**
   * Replace any plaintext token stored by an older version with its hash. Idempotent, writes
   * only when something changed, and never logs a token. Returns how many keys changed.
   */
  migrateLegacyTokens(): Promise<number>;
  /**
   * Update server name in all bearer keys (when server is renamed)
   */
  updateServerName(oldName: string, newName: string): Promise<number>;
}

/**
 * JSON file-based BearerKey DAO implementation
 * Stores keys under the top-level `bearerKeys` field in mcp_settings.json
 * and performs one-time migration from legacy routing.enableBearerAuth/bearerAuthKey.
 */
const LEGACY_KEY_ID = 'legacy-default';

const toStoredForm = (key: BearerKey): BearerKey => {
  const { token, ...rest } = key;
  return token ? { ...rest, ...describeBearerToken(token) } : rest;
};

export class BearerKeyDaoImpl extends JsonFileBaseDao implements BearerKeyDao {
  private normalizeKey(key: BearerKey): BearerKey {
    return {
      ...key,
      kind: key.kind ?? 'system',
      // Last use lives in the usage sidecar, not in the settings file.
      lastUsedAt: mergeLastUsed(key.lastUsedAt, usageKeyForKey(key.id)),
    };
  }

  /**
   * The keys as stored, with any plaintext (an older version's file) replaced by its hash in
   * memory only. Reading never writes: persisting the migration is `migrateLegacyTokens()`'s job,
   * run once at startup, so a read-only or failing disk cannot fail a request.
   */
  private async loadKeysWithMigration(): Promise<BearerKey[]> {
    const { keys } = await this.readPlan();
    return keys.map((key) => this.normalizeKey(key));
  }

  private async readPlan(): Promise<{
    keys: BearerKey[];
    needsWrite: boolean;
    legacyCount: number;
  }> {
    const settings = await this.loadSettings();
    const routing = settings.systemConfig?.routing;
    const legacyRoutingKey = (routing?.bearerAuthKey || '').trim();

    // An existing array (including an empty one) is the key store; the routing key is stale.
    if (Array.isArray(settings.bearerKeys)) {
      const legacyCount = settings.bearerKeys.filter((key) => !!key.token).length;
      return {
        keys: settings.bearerKeys.map(toStoredForm),
        needsWrite: legacyCount > 0 || !!legacyRoutingKey,
        legacyCount,
      };
    }

    // One-time migration source: legacy routing.enableBearerAuth / bearerAuthKey.
    const keys: BearerKey[] = legacyRoutingKey
      ? [
          {
            // Constant, never derived from the token; saveKeys() assigns the real id on persist.
            id: LEGACY_KEY_ID,
            name: 'default',
            ...describeBearerToken(legacyRoutingKey),
            enabled: !!routing?.enableBearerAuth,
            kind: 'system',
            accessType: 'all',
            allowedGroups: [],
            allowedServers: [],
          },
        ]
      : [];
    return { keys, needsWrite: true, legacyCount: legacyRoutingKey ? 1 : 0 };
  }

  private async saveKeys(keys: BearerKey[]): Promise<void> {
    const settings = await this.loadSettings();
    settings.bearerKeys = keys.map(({ lastUsedAt: _lastUsedAt, ...key }) =>
      toStoredForm(key.id === LEGACY_KEY_ID ? { ...key, id: randomUUID() } : key),
    );
    if (settings.systemConfig?.routing?.bearerAuthKey)
      settings.systemConfig.routing.bearerAuthKey = '';
    await this.saveSettings(settings);
    pruneUsage('key:', new Set(keys.map((key) => usageKeyForKey(key.id))));
  }

  async recordLastUsed(id: string, at: string): Promise<void> {
    recordUsage(usageKeyForKey(id), at);
  }

  async migrateLegacyTokens(): Promise<number> {
    try {
      const { keys, needsWrite, legacyCount } = await this.readPlan();
      if (!needsWrite) return 0;
      await this.saveKeys(keys);
      if (legacyCount > 0) logger.log(`Hashed ${legacyCount} bearer key(s) stored in plaintext`);
      return legacyCount;
    } catch (error) {
      // Authentication keeps working from the in-memory hashes; the next start retries.
      logger.warn('Could not persist hashed bearer keys; plaintext remains in the settings file', {
        error: summarizeErrorForLogging(error),
      });
      return 0;
    }
  }

  async findAll(): Promise<BearerKey[]> {
    return await this.loadKeysWithMigration();
  }

  async findEnabled(): Promise<BearerKey[]> {
    const keys = await this.loadKeysWithMigration();
    return keys.filter((key) => key.enabled);
  }

  async findById(id: string): Promise<BearerKey | undefined> {
    const keys = await this.loadKeysWithMigration();
    return keys.find((key) => key.id === id);
  }

  async findByToken(token: string): Promise<BearerKey | undefined> {
    const keys = await this.loadKeysWithMigration();
    const presented = hashBearerToken(token);
    return keys.find((key) => bearerHashMatches(key.tokenHash, presented));
  }

  async findByOwner(owner: string): Promise<BearerKey[]> {
    const keys = await this.loadKeysWithMigration();
    return keys.filter((key) => key.kind === 'user' && key.owner === owner);
  }

  async create(data: Omit<BearerKey, 'id'>): Promise<BearerKey> {
    const keys = await this.loadKeysWithMigration();
    const newKey: BearerKey = toStoredForm({
      id: randomUUID(),
      ...data,
      createdAt: data.createdAt ?? new Date().toISOString(),
    });
    if (newKey.lastUsedAt) recordUsage(usageKeyForKey(newKey.id), newKey.lastUsedAt);
    keys.push(newKey);
    await this.saveKeys(keys);
    // The plaintext is handed back once, to be shown to its owner, and never stored.
    return data.token ? { ...newKey, token: data.token } : newKey;
  }

  async update(id: string, data: Partial<Omit<BearerKey, 'id'>>): Promise<BearerKey | null> {
    const keys = await this.loadKeysWithMigration();
    const index = keys.findIndex((key) => key.id === id);
    if (index === -1) {
      return null;
    }

    const updated: BearerKey = toStoredForm({
      ...keys[index],
      ...data,
      id: keys[index].id,
    });
    if (data.lastUsedAt) recordUsage(usageKeyForKey(updated.id), data.lastUsedAt);
    keys[index] = updated;
    await this.saveKeys(keys);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const keys = await this.loadKeysWithMigration();
    const next = keys.filter((key) => key.id !== id);
    if (next.length === keys.length) {
      return false;
    }
    await this.saveKeys(next);
    return true;
  }

  async deleteByOwner(owner: string): Promise<number> {
    const keys = await this.loadKeysWithMigration();
    const next = keys.filter((key) => key.kind !== 'user' || key.owner !== owner);
    const deletedCount = keys.length - next.length;
    if (deletedCount > 0) {
      await this.saveKeys(next);
    }
    return deletedCount;
  }

  async updateServerName(oldName: string, newName: string): Promise<number> {
    const keys = await this.loadKeysWithMigration();
    let updatedCount = 0;

    for (const key of keys) {
      let updated = false;

      if (key.allowedServers && key.allowedServers.length > 0) {
        const newServers = key.allowedServers.map((server) => {
          if (server === oldName) {
            updated = true;
            return newName;
          }
          return server;
        });

        if (updated) {
          key.allowedServers = newServers;
          updatedCount++;
        }
      }
    }

    if (updatedCount > 0) {
      await this.saveKeys(keys);
    }

    return updatedCount;
  }
}
