import { getActivityDao, isActivityLoggingEnabled } from '../dao/DaoFactory.js';
import type { ActivityHistoryRow } from '../dao/ActivityDao.js';
import { listConnectedClients, type ConnectedClientKind } from './connectedClientService.js';
import { BLOCKED_ACTIVITY_CODES } from './userServerStatusService.js';
import { getOAuthClientDao, getSystemConfigDao } from '../dao/index.js';
import type { SystemConfig } from '../types/index.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_ACTIVITY_RETENTION_DAYS = 90;
export const MAX_ACTIVITY_RETENTION_DAYS = 3650;
export const MAX_HISTORY_PAGE_SIZE = 100;
export const DEFAULT_HISTORY_PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention in days; anything missing or out of range falls back to the default. */
export const resolveActivityRetentionDays = (systemConfig?: SystemConfig | null): number => {
  const days = systemConfig?.workspace?.activityRetentionDays;
  return typeof days === 'number' &&
    Number.isInteger(days) &&
    days >= 1 &&
    days <= MAX_ACTIVITY_RETENTION_DAYS
    ? days
    : DEFAULT_ACTIVITY_RETENTION_DAYS;
};

export type ActivityResult = 'success' | 'error' | 'blocked';

/**
 * What the user is told about why a call failed: a short code, never the recorded message.
 * `blocked` comes from the dedicated `statusCode` column (the Server Status that stopped the
 * call), never from message text, so upstream text cannot imitate it and the credential-server
 * redaction of messages does not hide it. Any other recorded code means the target was
 * `unavailable`; MCPHub's own two fixed messages map to fixed categories; everything else,
 * including every recorded message that may quote upstream text, is `upstream_error`.
 */
export type ActivityReason =
  | 'tool_error'
  | 'credential_server_error'
  | 'unavailable'
  | 'upstream_error'
  | 'not_selected'
  | 'paused'
  | 'maintenance'
  | 'needs_auth'
  | 'revoked'
  | 'risk_not_enabled';

const TOOL_ERROR_MESSAGE = 'Tool returned error response';
const CREDENTIAL_SERVER_MESSAGE = 'Credential-templated server tool call failed';

export const classifyActivity = (
  row: Pick<ActivityHistoryRow, 'status' | 'errorMessage' | 'statusCode'>,
): { result: ActivityResult; reason?: ActivityReason } => {
  if (row.status !== 'error') return { result: 'success' };
  const code = row.statusCode;
  if (code) {
    return BLOCKED_ACTIVITY_CODES.includes(code)
      ? { result: 'blocked', reason: code as ActivityReason }
      : { result: 'error', reason: 'unavailable' };
  }
  const message = row.errorMessage ?? '';
  if (message === TOOL_ERROR_MESSAGE) return { result: 'error', reason: 'tool_error' };
  if (message === CREDENTIAL_SERVER_MESSAGE) {
    return { result: 'error', reason: 'credential_server_error' };
  }
  return { result: 'error', reason: 'upstream_error' };
};

export interface ActivityClientView {
  kind: ConnectedClientKind;
  id: string;
  /** The client's name, or null once it is gone (revoked or deleted). */
  name: string | null;
  /** Still able to act as the user: not revoked and not past the idle window. */
  active: boolean;
}

export interface ActivityItem {
  id: string;
  timestamp: string;
  server: string;
  tool: string;
  status: ActivityResult;
  durationMs: number;
  reason?: ActivityReason;
  /** Null for calls that did not arrive with a connected-client credential. */
  client: ActivityClientView | null;
}

export interface ActivityHistoryFilters {
  server?: string;
  status?: ActivityResult;
  clientId?: string;
  clientKind?: ConnectedClientKind;
  since?: Date;
  until?: Date;
}

interface CursorPosition {
  timestamp: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const encodeCursor = (row: { timestamp: Date | string; id: string }): string =>
  Buffer.from(`${new Date(row.timestamp).toISOString()}|${row.id}`).toString('base64url');

export const decodeCursor = (cursor: string): CursorPosition | null => {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const split = text.indexOf('|');
    const timestamp = new Date(text.slice(0, split));
    const id = text.slice(split + 1);
    return split > 0 && UUID.test(id) && !Number.isNaN(timestamp.getTime())
      ? { timestamp, id }
      : null;
  } catch {
    return null;
  }
};

export const isActivityHistoryAvailable = (): boolean =>
  isActivityLoggingEnabled() && Boolean(getActivityDao());

// Names of the clients rows point at. A client that can no longer act as the user is
// reported by its stored name when one survives (OAuth), otherwise as unknown.
const resolveClients = async (
  username: string,
  rows: ActivityHistoryRow[],
  systemConfig: SystemConfig | null | undefined,
): Promise<Map<string, ActivityClientView>> => {
  const wanted = new Map<string, { kind: ConnectedClientKind; id: string }>();
  for (const row of rows) {
    if ((row.clientKind === 'oauth' || row.clientKind === 'key') && row.clientId) {
      wanted.set(`${row.clientKind}:${row.clientId}`, { kind: row.clientKind, id: row.clientId });
    }
  }
  const resolved = new Map<string, ActivityClientView>();
  if (!wanted.size) return resolved;

  const live = new Map(
    (await listConnectedClients(username, systemConfig)).map((client) => [
      `${client.kind}:${client.id}`,
      client,
    ]),
  );
  for (const [key, { kind, id }] of wanted) {
    const current = live.get(key);
    if (current) {
      // An idle client is refused like a revoked one, so it no longer acts as the user.
      resolved.set(key, { kind, id, name: current.name, active: !current.idle });
      continue;
    }
    let name: string | null = null;
    if (kind === 'oauth') {
      try {
        name = (await getOAuthClientDao().findByClientId(id))?.name?.trim() || null;
      } catch (error) {
        logger.warn('Failed to resolve an OAuth client name for activity history', error);
      }
    }
    resolved.set(key, { kind, id, name, active: false });
  }
  return resolved;
};

/** One page of the caller's own history, metadata only. Payload columns are never read. */
export const listUserActivity = async (
  username: string,
  options: {
    filters: ActivityHistoryFilters;
    limit: number;
    cursor?: CursorPosition;
    systemConfig?: SystemConfig | null;
    now?: number;
  },
): Promise<{ items: ActivityItem[]; nextCursor: string | null }> => {
  const dao = getActivityDao();
  if (!dao) return { items: [], nextCursor: null };
  const { filters, limit, systemConfig } = options;

  // Nothing older than the retention window is shown, whether or not it has been purged yet.
  const floor = new Date(
    (options.now ?? Date.now()) - resolveActivityRetentionDays(systemConfig) * DAY_MS,
  );
  const since = filters.since && filters.since > floor ? filters.since : floor;

  const rows = await dao.findUserHistory({
    username,
    limit: limit + 1,
    server: filters.server,
    clientId: filters.clientId,
    clientKind: filters.clientKind,
    status: filters.status,
    blockedReasons: [...BLOCKED_ACTIVITY_CODES],
    since,
    until: filters.until,
    after: options.cursor,
  });
  const page = rows.slice(0, limit);
  const clients = await resolveClients(username, page, systemConfig);

  const items = page.map((row): ActivityItem => {
    const { result, reason } = classifyActivity(row);
    const clientKey = `${row.clientKind}:${row.clientId}`;
    return {
      id: row.id,
      timestamp: new Date(row.timestamp).toISOString(),
      server: row.server,
      tool: row.tool,
      status: result,
      durationMs: row.duration,
      ...(reason ? { reason } : {}),
      client: clients.get(clientKey) ?? null,
    };
  });
  return {
    items,
    nextCursor: rows.length > limit && page.length ? encodeCursor(page[page.length - 1]) : null,
  };
};

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export const ACTIVITY_PURGE_INTERVAL_MS = 60 * 60 * 1000;
export const ACTIVITY_PURGE_FIRST_RUN_MS = 60 * 1000;
export const ACTIVITY_PURGE_BUDGET_MS = 20 * 1000;

/** The administrator's retention in days, or null when none is set (activity is kept forever). */
export const resolveAdminRetentionDays = (systemConfig?: SystemConfig | null): number | null => {
  const days = systemConfig?.activityLog?.retentionDays;
  return typeof days === 'number' &&
    Number.isInteger(days) &&
    days >= 1 &&
    days <= MAX_ACTIVITY_RETENTION_DAYS
    ? days
    : null;
};

/**
 * Deletes activity older than the administrator's retention, and only when an administrator set
 * one: `systemConfig.activityLog.retentionDays`. With none, nothing is ever deleted, with or
 * without Workspace Mode. The window is never shorter than the per-user view window, so
 * history a user can still see is not removed. The settings are read fresh on every run so a
 * change made through another instance applies without a restart.
 */
export const purgeExpiredActivity = async (
  readConfig: () => Promise<SystemConfig | null | undefined> = () => getSystemConfigDao().get(),
  now: number = Date.now(),
): Promise<{ removed: number; done: boolean }> => {
  const systemConfig = await readConfig();
  const admin = resolveAdminRetentionDays(systemConfig);
  if (admin === null) return { removed: 0, done: true };
  const dao = isActivityLoggingEnabled() ? getActivityDao() : undefined;
  if (!dao) return { removed: 0, done: true };
  const days = Math.max(admin, resolveActivityRetentionDays(systemConfig));
  return await dao.purgeOlderThan(new Date(now - days * DAY_MS), {
    budgetMs: ACTIVITY_PURGE_BUDGET_MS,
  });
};

let purgeTimer: ReturnType<typeof setInterval> | undefined;
let firstRunTimer: ReturnType<typeof setTimeout> | undefined;
let purging = false;

/** Starts the periodic purge. Idempotent; the timers never keep the process alive. */
export const startActivityRetention = (
  readConfig?: () => Promise<SystemConfig | null | undefined>,
): void => {
  if (purgeTimer) return;
  const tick = () => {
    if (purging) return;
    purging = true;
    purgeExpiredActivity(readConfig)
      .then(
        ({ removed, done }) => {
          if (removed > 0) logger.log(`Purged ${removed} expired activity records`);
          if (!done) {
            logger.warn('Activity purge hit its time budget; the backlog continues next run');
          }
        },
        (error) => logger.warn('Activity retention purge failed', error),
      )
      .finally(() => {
        purging = false;
      });
  };
  purgeTimer = setInterval(tick, ACTIVITY_PURGE_INTERVAL_MS);
  purgeTimer.unref();
  firstRunTimer = setTimeout(tick, ACTIVITY_PURGE_FIRST_RUN_MS);
  firstRunTimer.unref();
};

export const stopActivityRetention = (): void => {
  if (purgeTimer) clearInterval(purgeTimer);
  if (firstRunTimer) clearTimeout(firstRunTimer);
  purgeTimer = undefined;
  firstRunTimer = undefined;
};
