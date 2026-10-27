import { getUserServerSelectionDao } from '../dao/DaoFactory.js';
import type { ToolRiskLevel } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { isToolRiskLevel } from '../utils/toolRisk.js';
import { getCachedSystemConfig } from '../utils/systemConfigCache.js';

// Another instance sharing the database can change a user's selection without this
// process seeing it, so cached entries expire on their own.
export const SELECTION_CACHE_TTL_MS = 5000;

// What a user chose for their own scope: the servers they selected and, per server, the
// highest tool risk level they allow (absent means `read`).
export interface UserSelectionScope {
  names: Set<string>;
  ceilings: Map<string, ToolRiskLevel>;
}

// Selection per user. Writes through this module invalidate the entry, so tools/list never
// has to reach storage on the hot path.
const selectedByUser = new Map<string, { scope: UserSelectionScope; expiresAt: number }>();
// Bumped on every invalidation. A read that started before a bump must not populate the
// cache, or it would store a result that predates the write.
const userGenerations = new Map<string, number>();
let globalGeneration = 0;

const generationOf = (username: string): string =>
  `${globalGeneration}:${userGenerations.get(username) ?? 0}`;

const invalidate = (username?: string): void => {
  if (username === undefined) {
    globalGeneration++;
    selectedByUser.clear();
    return;
  }
  userGenerations.set(username, (userGenerations.get(username) ?? 0) + 1);
  selectedByUser.delete(username);
};

export const isWorkspaceEnabled = (): boolean => {
  try {
    return getCachedSystemConfig()?.workspace?.enabled === true;
  } catch {
    return false;
  }
};

export const getUserSelectionScope = async (username: string): Promise<UserSelectionScope> => {
  const cached = selectedByUser.get(username);
  if (cached && cached.expiresAt > Date.now()) return cached.scope;
  const generation = generationOf(username);
  const rows = await getUserServerSelectionDao().listByUsername(username);
  const scope: UserSelectionScope = {
    names: new Set(rows.filter((row) => row.selected).map((row) => row.serverName)),
    ceilings: new Map(
      rows.flatMap((row) =>
        isToolRiskLevel(row.riskCeiling) ? [[row.serverName, row.riskCeiling] as const] : [],
      ),
    ),
  };
  if (generation === generationOf(username)) {
    selectedByUser.set(username, { scope, expiresAt: Date.now() + SELECTION_CACHE_TTL_MS });
  }
  return scope;
};

export const getSelectedServerNames = async (username: string): Promise<Set<string>> =>
  (await getUserSelectionScope(username)).names;

/** The level the user allows on a server; `read` until they choose otherwise. */
export const resolveRiskCeiling = (
  ceilings: ReadonlyMap<string, ToolRiskLevel>,
  serverName: string,
  // What applies until the user chooses: the administrator's default for the server.
  fallback: ToolRiskLevel = 'read',
): ToolRiskLevel => ceilings.get(serverName) ?? fallback;

export const setServerSelected = async (
  username: string,
  serverName: string,
  selected: boolean,
): Promise<void> => {
  // Selecting or deselecting never changes the user's risk choice: the DAO keeps it.
  await getUserServerSelectionDao().save({
    username,
    serverName,
    selected,
    updatedAt: new Date().toISOString(),
  });
  invalidate(username);
};

/** Changes the user's tool risk ceiling for a server without touching their selection. */
export const setServerRiskCeiling = async (
  username: string,
  serverName: string,
  riskCeiling: ToolRiskLevel,
): Promise<void> => {
  await getUserServerSelectionDao().saveRiskCeiling(
    username,
    serverName,
    riskCeiling,
    new Date().toISOString(),
  );
  invalidate(username);
};

// Cleanup after a server or user is deleted, or a server is renamed. A failure leaves
// rows that no visible server matches, so it is logged and must not fail the operation.
// When nothing matched, storage and the cache are left alone.
export const deleteUserServerSelections = async (filter: {
  serverName?: string;
  username?: string;
}): Promise<void> => {
  try {
    if ((await getUserServerSelectionDao().delete(filter)) === false) return;
  } catch (error) {
    logger.warn('Failed to remove user server selections', { ...filter, error });
    return;
  }
  invalidate(filter.username);
};

export const renameServerSelections = async (oldName: string, newName: string): Promise<void> => {
  try {
    if ((await getUserServerSelectionDao().renameServer(oldName, newName)) === false) return;
  } catch (error) {
    logger.warn('Failed to move user server selections', { oldName, newName, error });
    return;
  }
  invalidate();
};

export const clearServerSelectionCache = (): void => invalidate();
