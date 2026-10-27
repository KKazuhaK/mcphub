# Per-user server selection narrows MCP scope under Workspace Mode

Status: implemented behind `systemConfig.workspace.enabled` (default off).

## Decision

Each user keeps their own Server Selection, persisted per (user, server) in a
JSON sidecar (`<settings>.selections.json`) or the `user_server_selections`
table. Under Workspace Mode, MCP requests resolve servers from the
intersection of visibility, the requesting user's selection, and the global
`enabled` flag. The filter lives in `getVisibleServerInfos`, the single
MCP-side visibility entry point, and is activated per request through an
`AsyncLocalStorage` scope set by `withWorkspaceSelection`.

Selection is stored in its own table rather than modelled as an automatically
managed per-user Group. Groups are an admin curation tool; mixing user choices
into them would blur who decided what and make status harder to explain.

## Scope

- Applies to MCP transport requests with an authenticated user on the
  all-servers route, global `$smart`, or a single-server route.
- Does not apply to admin-defined Group routes (`/mcp/<group>`,
  `$smart/<group>`): a group is the admin's curation and is served as is. A
  group name still wins over a server name, as in routing.
- Does not apply to requests without a user, or to dashboard and REST calls,
  which name their target with `extra.server` or mark themselves with
  `extra.dashboard`. Neither field can be set by an MCP client.

## Consequences

- Selection narrows, never grants: visibility is re-checked on every request,
  so stale selection rows cannot expose a server the user may not see.
- Selections are cached per user for 5 seconds with a generation guard, so
  instances sharing a database converge within that window.
- Selection rows are excluded from settings export, templates and
  settings-sync declarations, and are removed with their server or user,
  including on settings-sync prune.
- A session's owner is recorded when the session is created; list_changed
  after a selection change is sent only to that user's sessions.
