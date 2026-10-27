# My activity: a per-user call history without payloads

Status: implemented behind `systemConfig.workspace.enabled` (default off).

## Decision

A user can see which client called which tool of which service, when, how it ended and
why, for their own calls only. `GET /api/workspace/activity` answers 404 when Workspace
Mode is off and acts on the session user: the username is never a parameter.

## Recording the client and the stop reason

Each activity row gains nullable `clientKind` (`oauth` | `key`) and `clientId` (the OAuth
client id or the bearer key id). They come from the credential the request authenticated
with, the same identity as a Connected Client (`SessionCredential`), carried to the tool
call through the request context; a reused Streamable HTTP session falls back to the
credential it was opened with when the request carries none, as `/messages` does. Calls
without such a credential (dashboard, system keys, forward auth) store null. `keyId` and
`keyName` keep their meaning.

These two columns are recorded **regardless of Workspace Mode**: they are nullable
metadata, useful to administrators too, and gating them would make the history empty for
the period before the mode is switched on.

A nullable `statusCode` column records why a call was stopped before the upstream: the
Server Status code at the status/access gate (`paused`, `maintenance`, `not_selected`,
`needs_auth`, `revoked`), or the internal unavailable reason of a failed target lookup. It is
set for every server type. The error text of a personal-credential server is still replaced
by a fixed message, but the code is kept, so such a call is reported as blocked rather than
as a credential-server error. The code is stored only when it is a short identifier
(`[a-z0-9_-]{1,40}`).

## What is returned

Per item: `id`, `timestamp`, `server`, `tool`, `status` (`success` | `error` | `blocked`),
`durationMs`, `reason`, and `client { kind, id, name, active }`. Tool input, tool output,
source address and the recorded error message are never returned, including when
`activityLog.storeToolPayload` is on and for administrators. The query selects metadata
columns only.

Error text can quote upstream responses (URLs, tokens, bodies), so it is not shown, and it is
never parsed for meaning. The reason is derived on read from the `statusCode` column:

- a blocking Server Status code: `blocked`, with that code;
- any other recorded code: `unavailable` (the code itself is not returned);
- no code, and exactly "Tool returned error response": `tool_error`; the credential-server
  message: `credential_server_error`;
- anything else: `upstream_error`.

Because blocked is read from a column MCPHub writes, upstream text cannot imitate it, and the
`status=blocked` / `status=error` filters are plain predicates on `statusCode` (indexed with
`username`). Rows written before the column existed have no code and read as errors.

A client that can no longer act as the user (revoked, or past `workspace.clientIdleDays`) is
reported with its stored OAuth name when one survives, otherwise with `name: null`, and
`active: false`.

## Paging, filters, limits

Newest first, keyset cursor over (timestamp, id); the cursor id must be a UUID, anything else
answers 400. `limit` 1 to 100 (default 20). Filters: `server`, `status` (`success`, `error`,
`blocked`), `clientId` (with optional `clientKind`), `since`, `until`. A `since` earlier than
the view window is raised to it. The route has its own per-user rate limit
(`ACTIVITY_RATE_LIMIT_MAX`, default 60 per `ACTIVITY_RATE_LIMIT_WINDOW_MS`, default one
minute), keyed by username.

## JSON mode

Activity logging is database-only and no JSON store is added. In JSON mode the endpoint
answers 200 `{ available: false }` so the page can explain that history needs database mode.

## Retention

Two separate settings:

- `workspace.activityRetentionDays` (default 90, integer 1 to 3650, validated on the
  system-config update path) only limits **the user view**: older rows are hidden from
  `/api/workspace/activity`. Nothing is deleted on its account.
- `activityLog.retentionDays` (absent by default, integer 1 to 3650, or `null` to remove) is
  the **administrator-wide** setting and the only thing that deletes activity. Absent means
  activity is kept forever, with or without Workspace Mode. It is set in the dashboard under
  System settings (administrators only), with a warning and a confirmation that older
  activity is permanently deleted.

While `activityLog.retentionDays` is set, an unref'd hourly timer (first run one minute after
start) deletes rows older than `max(activityLog.retentionDays, workspace.activityRetentionDays)`,
so history a user can still see is never purged. It runs regardless of Workspace Mode. The
settings are read from the system-config DAO on every run (not the per-process cache), so a
change made on another instance applies. Rows are removed in batches of 1000 ids until none
are left or a 20-second budget is spent; a remaining backlog is logged and continues on the
next run. The manual `DELETE /api/activities/cleanup` is unchanged.

## Indexes and upgrade

`synchronize` is the only schema mechanism in the project (there are no migrations), so a
migration with `CREATE INDEX CONCURRENTLY` does not fit. Two named indexes are added to
`activities`, plus the columns `status_code`, `client_kind`, `client_id`:

- `IDX_activities_username_timestamp` on `(username, timestamp)`
- `IDX_activities_username_status_code` on `(username, status_code)`

**The first boot after upgrading builds them**, which can take a while and block writes to
`activities` on a very large table. To control that, create them first without blocking writes:

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_activities_username_timestamp"
  ON "activities" ("username", "timestamp");
CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_activities_username_status_code"
  ON "activities" ("username", "status_code");
```

(`status_code` is a new column: add it first, or let one boot create the columns.) With these
names, synchronization finds the indexes present and keeps them. Start with
`MCPHUB_SKIP_ACTIVITY_INDEX=true` to stop synchronization from managing them at all: they are
declared with `synchronize: false`, so TypeORM neither creates nor drops them, whether or not
they exist. Without the indexes, history queries fall back to the `username` index.
