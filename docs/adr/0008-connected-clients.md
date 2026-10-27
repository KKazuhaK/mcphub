# Connected clients: per-user list, revoke and idle expiry

Status: implemented behind `systemConfig.workspace.enabled` (default off).

## Decision

A user can see every credential that can act as them on MCP routes and revoke any
one of them without affecting the others or their endpoint URL. Two kinds exist:

- `oauth`: an OAuth client holding a live access or refresh token for the user.
  One entry per (client, user); its id is the client id. The name is the
  registered client name, falling back to the client id.
- `key`: a user-level bearer key (`kind: 'user'`) the user owns.

`GET /api/workspace/clients`, `DELETE /api/workspace/clients/:kind/:id` and
`DELETE /api/workspace/clients` act on the session user only (404 when Workspace
Mode is off). An id that belongs to someone else, does not exist, or names an
unknown kind answers with the same 404. Token values, hashes and key values are
never returned.

## Last use

`lastUsedAt` is stored on the OAuth access token record and on the bearer key.
The token record is the one the client is presenting, so it is the natural place
to stamp; refresh rotation deletes the old record before the new one is saved, so
the grant's `grantCreatedAt` and `lastUsedAt` are handed over through the refresh
token's `user` object (the only value oauth2-server passes from the refresh
lookup to `saveToken`). A record written before `grantCreatedAt` existed carries
forward the age it already had (access token expiry minus the configured
lifetime) rather than being restamped. The listing groups a user's records by
client: created = earliest grant, last used = latest, expires = latest end of any
live record, idle = every grant idle.

It is written when the credential authenticates an MCP transport request, at most
once per credential per 60 seconds (in-memory, keyed by a digest, so a restart
may write once more), and **only while Workspace Mode is on**: with it off nothing
new is written. A failed write is logged without the credential and never fails
the request.

Where it is stored depends on the backend:

- **Database mode**: the `last_used_at` columns, written with a targeted
  `UPDATE ... WHERE id` / `WHERE access_token` (never read-merge-save). A
  credential revoked or edited concurrently is therefore not resurrected or
  reverted; the update simply matches no row.
- **JSON mode**: a sidecar `<settings>.usage.json`, written atomically, so a
  usage stamp never rewrites `mcp_settings.json`. Entries are keyed by key id or
  by a SHA-256 of the access token, never the token. The JSON DAOs merge the
  sidecar into what they return and strip `lastUsedAt` before writing settings;
  every save prunes sidecar entries whose credential is gone. Like the selections
  sidecar it stays out of settings exports. `lastUsedAt` and `grantCreatedAt` are
  also removed from the settings payload and the export.

## Idle expiry

Under Workspace Mode a credential unused for `workspace.clientIdleDays` days
(default 90, 0 disables; integer 0 to 3650, set through the system-config update
API, which answers 400 otherwise) is rejected at validation as if revoked: an idle
key is dropped from the enabled set, an idle OAuth grant resolves to no user, a
refresh of an idle grant is refused, and `/oauth/userinfo` refuses it. Keys and
OAuth read the same setting, from the cached system config.

Idle time runs from the latest of `lastUsedAt`, creation (`createdAt`,
`grantCreatedAt`) and `workspace.enabledAt`. `enabledAt` is stamped when the mode
is switched on (and again each time it is switched back on, and at startup or on
first use when an enabled mode has none), so enabling the mode can never expire a
credential that predates usage tracking, and a key with no creation date still
has a clock. Until `enabledAt` exists, idle expiry does not apply.

Idle credentials are still listed (flagged `idle: true`) so the user can revoke
them.

## Revocation reaching live sessions

Sessions record the credential they were opened with (`SessionContext.credential`:
OAuth client id or key id, plus `username`). Revoking closes that user's matching
sessions in this process. Every request re-validates its bearer anyway, so a
session held by another instance, or a stateless request, fails on its next call.
Revoking an OAuth client also drops the user's pending authorization codes for it.

An exchange already in flight is stopped too. Each revoke of a (user, client), or of
all of a user's clients, bumps an in-memory sequence number; a refresh or code
exchange records the number when it reads its grant, and `saveToken` refuses it
(`invalid_grant`) when a later revoke covers it, both before the write and, with the
new token taken back, after it. The check is per process: another instance still
re-validates every token on use, so at worst a token minted there is dead on arrival
once its record is gone.

## Not changed

Dynamic registration still creates clients owned by `dynamic-registration`;
grants are attributed to users through their tokens only. `revokeClientTokens`
(per client, all users) is not used by this feature.

## Hardening and known limits

- `enabledAt` is read clamped to now (a future value counts as now, so nothing idles out on its account until it is re-stamped). A stored value that
  is malformed or in the future is dropped and re-stamped on the next system-config save
  or first usage write. It is this instance's own bookkeeping: it is left out of the
  settings export, and nothing imported sets it. When storage already holds a valid value
  (another instance stamped it), `ensureWorkspaceEnabledAt` adopts it into the cache.
- The usage sidecar exists only while Workspace Mode is on: with it off nothing is read,
  written or pruned. Every sidecar read and write is guarded; a failure is logged and never
  fails the credential operation (refresh, revoke, save) it accompanies.
- Limit: the JSON sidecar is not coordinated between processes sharing one settings file;
  the last writer wins, which can drop a stamp. JSON mode is a single-process deployment.
- Limit: in JSON mode each read of the token list hashes every access token to look up
  its sidecar entry, which is O(tokens) per read.
