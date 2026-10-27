// Revoking a client for a user must also stop an exchange that is already in flight: a refresh
// or code exchange that read its grant before the revoke would otherwise mint a new token after
// it. Each revoke bumps a sequence number; an exchange remembers the number it started at and
// is refused when a later revoke covers its (user, client). In memory and per process: it only
// has to outlive an exchange, and other instances still re-validate every token on use.

const WILDCARD = '*';
const RETAIN_MS = 10 * 60 * 1000;

let sequence = 0;
const revocations = new Map<string, { seq: number; at: number }>();

const keyOf = (username: string, clientId: string): string => `${username}\0${clientId}`;

/** The current sequence; an exchange records it when it reads its grant. */
export const getRevocationSeq = (): number => sequence;

/** Note a revoke of one client for a user, or of all the user's clients when no client is given. */
export const noteGrantRevocation = (username: string, clientId: string = WILDCARD): void => {
  const now = Date.now();
  revocations.set(keyOf(username, clientId), { seq: ++sequence, at: now });
  for (const [key, entry] of revocations) {
    if (now - entry.at > RETAIN_MS) revocations.delete(key);
  }
};

/** True when (user, client) was revoked after an exchange recorded `seq`. */
export const isGrantRevokedSince = (username: string, clientId: string, seq: number): boolean =>
  (revocations.get(keyOf(username, clientId))?.seq ?? 0) > seq ||
  (revocations.get(keyOf(username, WILDCARD))?.seq ?? 0) > seq;

/** Test hook. */
export const resetGrantRevocations = (): void => {
  revocations.clear();
  sequence = 0;
};
