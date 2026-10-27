import { createHash } from 'node:crypto';
import {
  getBearerKeyDao,
  getOAuthClientDao,
  getOAuthTokenDao,
  getSystemConfigDao,
} from '../dao/index.js';
import { getCachedSystemConfig, setCachedSystemConfig } from '../utils/systemConfigCache.js';
import { revokeUserClientTokens, revokeUserTokens } from '../models/OAuth.js';
import type { BearerKey, IOAuthToken, SystemConfig } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { findExternalResource } from '../utils/externalResources.js';

export type ConnectedClientKind = 'oauth' | 'key';

export interface ConnectedClient {
  id: string;
  kind: ConnectedClientKind;
  name: string;
  clientId?: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt?: string;
  scopes?: string[];
  /** Names of the external resources this client holds tokens for (JWT access tokens, ADR 0014). */
  resources?: string[];
  enabled?: boolean;
  /** Unused past the idle window: refused like a revoked client, still listed so it can be removed. */
  idle: boolean;
}

/** Identifies the credential an MCP session was opened with. */
export interface SessionCredential {
  kind: ConnectedClientKind;
  /** OAuth: the client id (one grant per client and user). Key: the key id. */
  id: string;
}

export const DEFAULT_CLIENT_IDLE_DAYS = 90;
export const LAST_USED_THROTTLE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = 3600;

/**
 * Idle window in milliseconds, or 0 when idle expiry does not apply: the workspace is off,
 * the window is 0 days, or the mode has no `enabledAt` yet (it is stamped on first use, and
 * until then nothing can be measured safely). Invalid values fall back to 90 days.
 */
export const resolveClientIdleMs = (systemConfig?: SystemConfig | null): number => {
  const workspace = systemConfig?.workspace;
  if (workspace?.enabled !== true || parseTime(workspace.enabledAt) === undefined) return 0;
  const days = workspace.clientIdleDays;
  if (days === undefined || days === null || !Number.isFinite(days) || days < 0) {
    return DEFAULT_CLIENT_IDLE_DAYS * DAY_MS;
  }
  return days * DAY_MS;
};

const isIdleSince = (reference: number | undefined, idleMs: number, now: number): boolean =>
  idleMs > 0 && reference !== undefined && !Number.isNaN(reference) && now - reference > idleMs;

function parseTime(value?: string): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) ? undefined : time;
}

// Idle time runs from the latest of last use, creation and the moment the workspace was
// enabled, so switching the mode on never expires a credential that predates tracking.
const idleReference = (
  systemConfig: SystemConfig | null | undefined,
  now: number,
  ...times: Array<number | undefined>
): number | undefined => {
  // An enabledAt in the future (clock change, hand edit) counts as now, so it can never
  // push the reference past the present and keep a credential alive indefinitely.
  const enabledAt = parseTime(systemConfig?.workspace?.enabledAt);
  const known = [...times, enabledAt === undefined ? undefined : Math.min(enabledAt, now)].filter(
    (time): time is number => time !== undefined,
  );
  return known.length ? Math.max(...known) : undefined;
};

/** True when `value` is an ISO date that is not in the future. */
export const isValidEnabledAt = (value: unknown, now: number = Date.now()): boolean => {
  const time = typeof value === 'string' ? parseTime(value) : undefined;
  return time !== undefined && time <= now;
};

/**
 * A grant's creation time. Records written before it was tracked are dated from the access
 * token they hold: expiry minus the configured lifetime.
 */
export const oauthGrantCreatedAt = (
  token: IOAuthToken,
  systemConfig?: SystemConfig | null,
): number => {
  const recorded = parseTime(token.grantCreatedAt);
  if (recorded !== undefined) return recorded;
  const lifetime =
    systemConfig?.oauthServer?.accessTokenLifetime || DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS;
  return new Date(token.accessTokenExpiresAt).getTime() - lifetime * 1000;
};

/** True when a user-level key has gone unused for longer than the idle window. */
export const isKeyIdle = (
  key: BearerKey,
  systemConfig?: SystemConfig | null,
  now: number = Date.now(),
): boolean => {
  if (key.kind !== 'user') return false;
  return isIdleSince(
    idleReference(systemConfig, now, parseTime(key.lastUsedAt), parseTime(key.createdAt)),
    resolveClientIdleMs(systemConfig),
    now,
  );
};

/** True when an OAuth token record's grant has gone unused for longer than the idle window. */
export const isOAuthTokenIdle = (
  token: IOAuthToken,
  systemConfig?: SystemConfig | null,
  now: number = Date.now(),
): boolean =>
  isIdleSince(
    idleReference(
      systemConfig,
      now,
      parseTime(token.lastUsedAt),
      oauthGrantCreatedAt(token, systemConfig),
    ),
    resolveClientIdleMs(systemConfig),
    now,
  );

// ---------------------------------------------------------------------------
// Last use
// ---------------------------------------------------------------------------

// At most one write per credential per window. Keys are digests, never credential values.
const lastWrite = new Map<string, number>();

const claimWrite = (digestSource: string, now: number): boolean => {
  const key = createHash('sha256').update(digestSource).digest('hex').slice(0, 32);
  const previous = lastWrite.get(key);
  if (previous !== undefined && now - previous < LAST_USED_THROTTLE_MS) return false;
  if (lastWrite.size > 2000) {
    for (const [entry, at] of lastWrite) {
      if (now - at >= LAST_USED_THROTTLE_MS) lastWrite.delete(entry);
    }
  }
  lastWrite.set(key, now);
  return true;
};

/** Test hook: forget throttle state. */
export const resetLastUsedThrottle = (): void => lastWrite.clear();

// Last use is only tracked while the workspace is on; with it off nothing extra is written.
const isTrackingUse = (): boolean => getCachedSystemConfig()?.workspace?.enabled === true;

let stampingEnabledAt: Promise<void> | null = null;

/**
 * Make sure an enabled workspace has an `enabledAt`, the floor for idle measurement. Covers a
 * mode that was switched on by editing the settings rather than through the API.
 */
export const ensureWorkspaceEnabledAt = async (): Promise<void> => {
  const cached = getCachedSystemConfig();
  if (cached?.workspace?.enabled !== true || isValidEnabledAt(cached.workspace.enabledAt)) return;
  stampingEnabledAt ??= (async () => {
    const dao = getSystemConfigDao();
    const current = await dao.get();
    if (current?.workspace?.enabled !== true) return;
    if (isValidEnabledAt(current.workspace.enabledAt)) {
      // Another instance already stamped it: adopt that value instead of writing our own.
      setCachedSystemConfig(current);
      return;
    }
    // Missing, malformed or in the future: stamp afresh.
    const next: SystemConfig = {
      ...current,
      workspace: { ...current.workspace, enabledAt: new Date().toISOString() },
    };
    await dao.update(next);
    setCachedSystemConfig(next);
  })()
    .catch((error) => logger.warn('Failed to record when the workspace was enabled', error))
    .finally(() => {
      stampingEnabledAt = null;
    });
  await stampingEnabledAt;
};

/** Record that an OAuth access token authenticated an MCP request. Never throws. */
export const recordOAuthTokenUse = async (accessToken: string): Promise<void> => {
  if (!isTrackingUse()) return;
  const now = Date.now();
  if (!claimWrite(`oauth:${accessToken}`, now)) return;
  try {
    await ensureWorkspaceEnabledAt();
    await getOAuthTokenDao().recordLastUsed(accessToken, new Date(now).toISOString());
  } catch (error) {
    logger.warn('Failed to record OAuth client last use', error);
  }
};

/** Record that a bearer key authenticated an MCP request. Never throws. */
export const recordBearerKeyUse = async (keyId: string): Promise<void> => {
  if (!isTrackingUse()) return;
  const now = Date.now();
  if (!claimWrite(`key:${keyId}`, now)) return;
  try {
    await ensureWorkspaceEnabledAt();
    await getBearerKeyDao().recordLastUsed(keyId, new Date(now).toISOString());
  } catch (error) {
    logger.warn('Failed to record bearer key last use', error);
  }
};

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const isTokenLive = (token: IOAuthToken, now: number): boolean => {
  if (new Date(token.accessTokenExpiresAt).getTime() > now) return true;
  if (!token.refreshToken) return false;
  return !token.refreshTokenExpiresAt || new Date(token.refreshTokenExpiresAt).getTime() > now;
};

const listOAuthClients = async (
  username: string,
  systemConfig: SystemConfig | null | undefined,
  now: number,
): Promise<ConnectedClient[]> => {
  const tokens = (await getOAuthTokenDao().findByUsername(username)).filter((token) =>
    isTokenLive(token, now),
  );
  const byClient = new Map<string, IOAuthToken[]>();
  for (const token of tokens) {
    byClient.set(token.clientId, [...(byClient.get(token.clientId) ?? []), token]);
  }

  const clientDao = getOAuthClientDao();
  const entries: ConnectedClient[] = [];
  for (const [clientId, grants] of byClient) {
    const client = await clientDao.findByClientId(clientId);
    const created = Math.min(...grants.map((grant) => oauthGrantCreatedAt(grant, systemConfig)));
    const used = grants
      .map((grant) => parseTime(grant.lastUsedAt))
      .filter((time): time is number => time !== undefined);
    // The grant ends when its last refresh token (or, without one, access token) expires.
    // A refresh token with no expiry never ends on its own, so no expiry is reported.
    const ends = grants.map((grant) =>
      grant.refreshToken
        ? grant.refreshTokenExpiresAt
          ? new Date(grant.refreshTokenExpiresAt).getTime()
          : undefined
        : new Date(grant.accessTokenExpiresAt).getTime(),
    );
    const scopes = [
      ...new Set(grants.flatMap((grant) => (grant.scope ? grant.scope.split(' ') : []))),
    ].filter(Boolean);

    // A grant for an external resource is shown as the client with the resource's name.
    const resourceNames = [
      ...new Set(
        grants
          .filter((grant) => grant.resource)
          .map(
            (grant) => findExternalResource(systemConfig, grant.resource!)?.name ?? grant.resource!,
          ),
      ),
    ];
    const clientName = client?.name?.trim() || clientId;

    entries.push({
      id: clientId,
      kind: 'oauth',
      name:
        resourceNames.length > 0 && grants.every((grant) => grant.resource)
          ? `${clientName} (${resourceNames.join(', ')})`
          : clientName,
      ...(resourceNames.length ? { resources: resourceNames } : {}),
      clientId,
      createdAt: new Date(created).toISOString(),
      lastUsedAt: used.length ? new Date(Math.max(...used)).toISOString() : null,
      ...(ends.every((end) => end !== undefined)
        ? { expiresAt: new Date(Math.max(...(ends as number[]))).toISOString() }
        : {}),
      ...(scopes.length ? { scopes } : {}),
      // One active grant keeps the client active.
      idle: grants.every((grant) => isOAuthTokenIdle(grant, systemConfig, now)),
    });
  }
  return entries;
};

const listKeys = async (
  username: string,
  systemConfig: SystemConfig | null | undefined,
  now: number,
): Promise<ConnectedClient[]> =>
  (await getBearerKeyDao().findByOwner(username)).map((key) => ({
    id: key.id,
    kind: 'key' as const,
    name: key.name,
    createdAt: key.createdAt ?? null,
    lastUsedAt: key.lastUsedAt ?? null,
    enabled: key.enabled,
    idle: isKeyIdle(key, systemConfig, now),
  }));

/** Every credential that can act as `username` on MCP routes. Never includes secrets. */
export const listConnectedClients = async (
  username: string,
  systemConfig?: SystemConfig | null,
): Promise<ConnectedClient[]> => {
  const now = Date.now();
  const [oauth, keys] = await Promise.all([
    listOAuthClients(username, systemConfig, now),
    listKeys(username, systemConfig, now),
  ]);
  return [...oauth, ...keys];
};

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

// Live MCP sessions opened with the revoked credential are closed. Auth is also
// re-validated on every request, so this only ends streams that are already open.
const closeLiveSessions = async (
  username: string,
  credential?: SessionCredential,
): Promise<void> => {
  try {
    const { closeSessionsForCredential } = await import('./sseService.js');
    closeSessionsForCredential(username, credential);
  } catch (error) {
    logger.warn('Failed to close sessions of a revoked client', error);
  }
};

/**
 * Revoke one of `username`'s clients. Returns false when the user has no such client, which
 * is the same answer for an id that belongs to someone else and one that does not exist.
 */
export const revokeConnectedClient = async (
  username: string,
  kind: ConnectedClientKind,
  id: string,
): Promise<boolean> => {
  if (kind === 'oauth') {
    const owned = (await getOAuthTokenDao().findByUsername(username)).some(
      (token) => token.clientId === id,
    );
    if (!owned) return false;
    await revokeUserClientTokens(username, id);
  } else {
    const dao = getBearerKeyDao();
    const key = await dao.findById(id);
    if (!key || key.kind !== 'user' || key.owner !== username) return false;
    await dao.delete(id);
  }
  await closeLiveSessions(username, { kind, id });
  return true;
};

/** Revoke every OAuth grant and user-level key of `username`. */
export const revokeAllConnectedClients = async (username: string): Promise<void> => {
  await revokeUserTokens(username);
  await getBearerKeyDao().deleteByOwner(username);
  await closeLiveSessions(username);
};
