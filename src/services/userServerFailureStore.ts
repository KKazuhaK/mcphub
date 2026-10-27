// Recent upstream failures per (user, server). Status is derived from this together with
// configuration; nothing here is persisted, so a restart forgets failures and the next
// call decides again.

// `auth`: the upstream rejected the user's credential. `misconfigured`: the credential
// store or server setup is broken and an administrator must act. `runtime`: anything else.
export type UserServerFailureKind = 'auth' | 'misconfigured' | 'runtime';

export interface UserServerFailure {
  kind: UserServerFailureKind;
  // Epoch milliseconds of the most recent failure.
  at: number;
}

// Bounds memory when many users hit many broken servers.
export const MAX_FAILURE_ENTRIES = 2000;
// A rejected credential stays rejected until the user changes it (which clears the entry);
// the TTL only keeps a forgotten entry from lingering forever.
export const AUTH_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
// Other failures are only worth reporting while they are recent.
export const RUNTIME_FAILURE_TTL_MS = 10 * 60 * 1000;

const failures = new Map<string, UserServerFailure>();

// Users whose credential a server's transport recently refused. One refusal is most likely
// that user's credential; refusals for several users at once point at the server itself.
export const AUTH_REJECTION_WINDOW_MS = 10 * 60 * 1000;
const MAX_REJECTION_SERVERS = 500;
const MAX_REJECTION_USERS = 200;
const rejections = new Map<string, Map<string, number>>();

// Notes a refusal and returns every user refused on this server within the window.
export const noteAuthRejection = (
  username: string,
  serverName: string,
  now: number = Date.now(),
): string[] => {
  const users = rejections.get(serverName) ?? new Map<string, number>();
  for (const [user, at] of users) if (now - at >= AUTH_REJECTION_WINDOW_MS) users.delete(user);
  users.delete(username);
  users.set(username, now);
  while (users.size > MAX_REJECTION_USERS) {
    const oldest = users.keys().next().value;
    if (oldest === undefined) break;
    users.delete(oldest);
  }
  rejections.delete(serverName);
  rejections.set(serverName, users);
  while (rejections.size > MAX_REJECTION_SERVERS) {
    const oldest = rejections.keys().next().value;
    if (oldest === undefined) break;
    rejections.delete(oldest);
  }
  return [...users.keys()];
};

const keyOf = (username: string, serverName: string): string =>
  JSON.stringify([username, serverName]);

const isExpired = (failure: UserServerFailure, now: number): boolean =>
  now - failure.at >= (failure.kind === 'auth' ? AUTH_FAILURE_TTL_MS : RUNTIME_FAILURE_TTL_MS);

export const getUserServerFailure = (
  username: string,
  serverName: string,
  now: number = Date.now(),
): UserServerFailure | undefined => {
  const key = keyOf(username, serverName);
  const failure = failures.get(key);
  if (!failure) return undefined;
  if (isExpired(failure, now)) {
    failures.delete(key);
    return undefined;
  }
  return failure;
};

export const recordUserServerFailure = (
  username: string,
  serverName: string,
  kind: UserServerFailureKind,
  now: number = Date.now(),
): void => {
  const key = keyOf(username, serverName);
  // Re-inserting moves the entry to the end, so the oldest entry is the eviction candidate.
  failures.delete(key);
  failures.set(key, { kind, at: now });
  while (failures.size > MAX_FAILURE_ENTRIES) {
    const oldest = failures.keys().next().value;
    if (oldest === undefined) break;
    failures.delete(oldest);
  }
};

// Returns true when a live failure was removed.
export const clearUserServerFailure = (
  username: string,
  serverName: string,
  kind?: UserServerFailureKind,
): boolean => {
  const failure = getUserServerFailure(username, serverName);
  if (!failure || (kind && failure.kind !== kind)) return false;
  failures.delete(keyOf(username, serverName));
  if (failure.kind === 'auth' || failure.kind === 'misconfigured')
    rejections.get(serverName)?.delete(username);
  return true;
};

// Cleanup after a user or server is deleted, a server is renamed, or credentials change.
// With neither field set, every entry is removed.
export const clearUserServerFailures = (
  filter: { username?: string; serverName?: string } = {},
): void => {
  for (const key of [...failures.keys()]) {
    const [username, serverName] = JSON.parse(key) as [string, string];
    if (filter.username !== undefined && filter.username !== username) continue;
    if (filter.serverName !== undefined && filter.serverName !== serverName) continue;
    failures.delete(key);
  }
  for (const [server, users] of [...rejections]) {
    if (filter.serverName !== undefined && filter.serverName !== server) continue;
    if (filter.username === undefined) rejections.delete(server);
    else users.delete(filter.username);
  }
};

export const getUserServerFailureCount = (): number => failures.size;
