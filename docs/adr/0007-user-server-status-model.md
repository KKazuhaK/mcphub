# Per-user server status explains why a visible server is unusable

Status: implemented behind `systemConfig.workspace.enabled` (default off).

## Decision

Under Workspace Mode every server a user can see has a status for that user,
resolved by a pure function (`resolveUserServerState`) in priority order:
`not_selected`, `paused`, `needs_auth`, `revoked`, `credential_invalid`,
`error`, `available`. A thin adapter in `userServerStatusService.ts` gathers
the inputs: the selection service, the global `enabled` flag, credential
binding or personal OAuth state, the shared connection state, and a bounded
in-memory store of the user's recent upstream failures.

The status reaches users three ways:

- `GET /api/workspace/servers` adds `status` to each server, and
  `GET /api/workspace/summary` reports `endpointState` (`normal`, `partial`,
  `empty`) with a count per state.
- MCP tool calls, prompt gets and resource reads that address a visible server
  in a non-`available` state return the status message, with
  `_meta["mcphub/status"] = { server, code, action }`, instead of the generic
  error.
- The user's own MCP sessions get a list-changed notification when they save or
  delete a credential or connect or disconnect personal OAuth. Failure and
  recovery do not notify: lists do not change when a server's status does.

## Consequences

- Existence is never leaked: a target the user cannot see is not resolved by
  the status gate and produces exactly the generic "not available" text
  (#1103). Messages are fixed, translated text; upstream error bodies and URLs
  are never stored or surfaced.
- Only states taken from configuration (`not_selected`, `paused`, `needs_auth`,
  `revoked`) stop a call before it reaches the upstream. A down shared
  connection, `credential_invalid` and recorded `error` describe the last
  attempt or the shared connection, so they never block: the call, with its
  existing reconnect logic, is what finds out whether they healed. They still
  appear in the workspace API.
- A credential counts as rejected only on: a structured upstream tool result
  whose JSON text (or structured content) has `error` of `CREDENTIAL_INVALID`
  or `CONNECTION_REVOKED`; an HTTP 401 or `invalid_token` challenge from the
  upstream transport while preparing the user's personal runtime; or a personal
  OAuth refresh answered with `invalid_grant`. Never a 403, never message text,
  never an ordinary tool-level failure (an OpenAPI "403 Forbidden" or "Order 401
  not found" is the tool's own answer).
- A tool's actual result is never replaced. A result classified as a rejected
  credential keeps its content and gains the status in `_meta` plus one short
  text item after it. Only a failure to prepare the personal runtime, where no
  upstream result exists, returns a status-only result.
- Runtime preparation failures are told apart by error class, not message text:
  a missing binding (`MissingCredentialError`) is `needs_auth` from
  configuration and is not remembered; a binding that changed mid-request
  (`CredentialBindingConflictError`) is `error` with `retry_later`; a broken
  credential store (`CredentialBindingConfigError`) is `error` with
  `contact_admin`. A user who cannot hold personal credentials gets
  `needs_auth` with `contact_admin`.
- Each call decides from its own outcome, and records success where it records
  failure, on every route including admin group routes. A success clears the
  remembered failure; saving or deleting credentials, reconnecting OAuth, and
  deleting a user or server also clear it.
- A call stopped by the gate leaves the same log line and activity entry as the
  generic failure it replaces, with the status code as the internal reason.
- The status gate names a server only when the route is that single server or
  the server exposes the requested name: in its shared cached lists, or in the
  lists the requesting user's own runtime last returned. A server needing
  personal credentials has no shared lists, so a bounded per-(user, server)
  record of the names that user's runtime listed is kept (cleared with the
  failure store on credential, user and server changes) and consulted only for
  that user. There is deliberately no bare name-prefix fallback: choosing
  between candidates by the existence of servers the user cannot see would leak
  it. Consequence: a user who never connected an unselected or paused personal
  server gets the generic error on aggregate and `$smart` routes, and the
  status only on that server's single-server route. A selected, enabled
  personal server is explained while its runtime is prepared, and that path
  leaves the same activity entry as the gate.
- A structured `CREDENTIAL_INVALID` / `CONNECTION_REVOKED` result is recorded
  and annotated only for servers with personal authentication; from a shared
  server it is an ordinary tool result.
- A transport 401 while connecting a credential-template server is the user's
  rejected credential only for the first user. When two or more distinct users
  are refused by the same server within 10 minutes it is recorded as the
  server's misconfiguration (`error`, `contact_admin`) for all of them.
  Personal OAuth refusals stay per user. Any other `CredentialBindingError`
  during preparation (invalid template, broken store) is also `contact_admin`.
  Nothing probes credentials proactively.
- Admin-defined group routes keep their selection exemption, but a personal
  runtime failure on them is explained by the same model.

## Addendum: per-user pause and maintenance

Three administrator-controlled kinds of unavailability are told apart. The global
`enabled: false` is unchanged (`paused`, action `contact_admin`). Two new
`ServerConfig` fields refine it, both effective only under Workspace Mode and
stored but ignored with it off:

- `pausedUsers: string[]` pauses a server for the listed usernames only. The
  status is `paused` with `contact_admin` for them; nobody else is affected.
- `maintenance: { until?, message? }` puts a server in the `maintenance` state
  with action `retry_later`. The message names the end time (UTC ISO 8601) when
  `until` is set and appends the administrator's `message` (plain text, at most
  200 characters, no control, Unicode format or line-separator characters; stored messages are
  sanitized again and truncated whenever they are read). A window ends by
  itself once `until` passes: it is computed when read, so nothing is written.
  Maintenance does not touch the upstream connection or `enabled`.

Priority becomes `not_selected`, `paused`, `maintenance`, `needs_auth`,
`revoked`, `credential_invalid`, `error`, `available`. `paused` and
`maintenance` are blocking: a call is answered with the status and leaves the
same log and activity entry as any other gated call. The administrator's
maintenance message is the one piece of free text a status can carry; it is
admin-authored configuration, never upstream output.

### Access controls, not selection

Pause and maintenance are admin access controls. Unlike Server Selection they
apply on **every** route under Workspace Mode: the all-servers, single-server
and `$smart` routes, admin group routes (`/mcp/<group>`, `$smart/<group>`), and
dashboard/REST calls (`extra.dashboard`, `extra.server`: tool calls, OpenAPI,
prompts, resource reads), for both lists and calls.

- A pause blocks exactly the listed users, administrators included.
- Maintenance blocks every requester except administrators, who bypass it so
  they can test. A request without a user (a system bearer key) is blocked.
- Selection (M1) is scoped exactly as before. Where both apply, `not_selected`
  still outranks `paused` and `maintenance` in the status.

Lists follow calls: a blocked server is left out of that requester's tools,
prompts and resources lists and of `$smart` search (the filter in
`getVisibleServerInfos`), while the workspace API still reports it with its
status. A call is stopped by the access gate only when every server it could
reach is blocked, so a status is never reported for a call that was not gated;
an administrator in a maintenance window sees `available`. On a group route the
gate only considers the group's member servers and only for callers the group is
open to; a server outside that scope keeps the generic "not available" answer,
so its maintenance state is never revealed. The generated OpenAPI specification
leaves out blocked servers like any other list.

### Notifications

A change of `pausedUsers` notifies the users added or removed through the
targeted notifier. Maintenance starting or ending notifies every open MCP
session, since it applies to all routes whether or not the server was
selected; editing only the message or end time changes no list. One timer per
server fires when a window with `until` ends. It is cleared on edit and delete,
moved only after a rename succeeds (a failed rename leaves the old timer
armed), and re-armed at startup; a delay beyond the timer limit re-arms
itself. Switching Workspace Mode on or off already broadcasts a list change to
all sessions (M1), which covers a window that was active when it was enabled.

### Authorization, validation and exposure

Both fields are administrator-only to write. A non-admin request that carries
the `pausedUsers` or `maintenance` key at all, with any value including one
equal to what is stored, `[]` or `null`, is refused with 403 and a constant
message, so the answer reveals nothing about the stored value. A save that
omits a key keeps the stored value; `null` or an empty value clears it. This
also means owners cannot lock out their own server or author text shown to
users. `pausedUsers` is also administrator-only to read: the owner's config
view drops it. Active `until` and `message` are visible to anyone who can see
the server. The dashboard shows both controls to administrators only.

Only incoming values are validated. `pausedUsers` must be an array of strings
(deduplicated, at most 1000). `maintenance.until` must be a full ISO 8601
date-time with an explicit zone that is a real calendar instant (2026-02-30 is
refused), is stored as UTC, and must be in the future when it is written (the
unchanged stored value saved back is accepted). A stored value that is malformed
(hand-edited) is not re-validated on unrelated edits and does not make them
fail: a malformed maintenance window is treated as inactive and malformed
`pausedUsers` entries are ignored, each with a logged warning, until an admin
edit fixes or clears it.

Neither field is part of templates (export drops them, import ignores them),
duplicates (the dashboard does not copy them), settings export for non-admins,
or settings-sync declarations: a sync leaves them as the administrator set them,
and the declaration fingerprint (type, URL, owner, OAuth) is unaffected, so
toggling maintenance never invalidates upstream OAuth state.

### Known limitations

- Like other in-memory server state, a pause or maintenance edit is applied to
  the live server entry of the instance that handled it. Instances sharing a
  database converge when their server entries next reload (restart or config
  reload), not immediately, and do not receive the targeted notifications.
- A request with no user is treated as non-admin for maintenance everywhere, so
  background code that resolves visible servers outside a request would also see
  a server in maintenance as hidden.
