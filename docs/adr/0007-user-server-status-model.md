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
- The code set is open to a later `maintenance` state alongside `paused`.
