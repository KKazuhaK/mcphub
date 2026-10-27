# Tool risk levels: a user ceiling and an administrator cap

Status: implemented behind `systemConfig.workspace.enabled` (default off). With the setting
off nothing in this record applies: lists, search and calls behave as before, and the stored
fields are ignored.

## Decision

Every tool has a risk level taken from its standard MCP annotations, ordered
`read` < `write` < `external`:

- `read`: `readOnlyHint === true`.
- `write`: not read-only and `openWorldHint === false` (changes only the user's own data).
- `external`: everything else. A tool with no annotations, or annotations that are not
  booleans, is `external`: the level says what MCPHub can vouch for, not what a tool might
  turn out to do.

Annotations are claims made by the upstream, so under Workspace Mode they are **believed only
for servers owned by an administrator** (a server with no owner is the default administrator's).
For a server owned by anyone else every tool is `external`, whatever it declares; overrides
still apply on top and can only keep or raise. Ownership is read from the user store through a
5-second cache (`annotationTrustService`); a cold or unreadable cache trusts nobody. The
workspace page tells users when a service's tools are unverified for this reason
(`annotationsTrusted: false`).

An administrator may only **raise** a tool (`ServerConfig.toolRiskOverrides`, keyed like
per-tool settings: runtime or bare name). The effective level is
`max(computed, override)` whenever it is read, so a stored override lower than the computed
level (written by hand, or made obsolete by an upstream annotation change) is inert.

Two independent controls cap what a requester can use:

- **User ceiling** (`riskCeiling` on the Server Selection record, per user and server,
  `read` until chosen). It is the user's own choice, so it is scoped exactly like Server
  Selection (the all-servers route, global `$smart`, single-server routes for an authenticated
  user) and rides on the same `AsyncLocalStorage` scope; admin Group routes, requests without
  a user and dashboard/REST calls are untouched.
- **Administrator cap** (`ServerConfig.maxToolRisk`, absent means no cap). An access control,
  scoped like Maintenance: every route (including admin Group routes and dashboard/REST
  calls), lists and calls, every requester except administrators. A request without a user is
  not exempt.

A user who has not chosen a ceiling starts at the server's `defaultUserRisk` (administrator-only
like the other fields, `read` when unset). It may never exceed `maxToolRisk`: a save that would
leave the default above the cap, by raising the default or lowering the cap, is rejected with
400. The workspace API reports the effective ceiling (the choice, else the default, never above
the cap) and `riskCeilingIsDefault`; the default itself is never exposed. A change of the default
notifies every open session, like a change of the cap.

The requester is held to `min(ceiling, cap)` on their own routes and to the cap alone
elsewhere. Administrators are exempt from the cap but not from their own ceiling.

## Where it is applied

A tool above the effective level is removed from `tools/list` (via `listGroupTools`, which
also builds a `$smart/<group>` list's pinned tools), from `search_tools` hits and from
`describe_tool`, and from the generated OpenAPI specification and the dashboard server list
(`/api/servers`, `/api/servers/:name`), both by the cap only (those are not selection routes),
for non-admin requesters, owners included. The filter is deliberately **not** inside `filterToolsByConfig`, because
that function also decides which tools are embedded for search, which is shared state and
must not depend on the requester.

Calls are gated where the tool is resolved (`findToolOnServer`), so every route and every
caller of that helper is covered, including `call_tool`, group routes and a server woken from
sleep:

- Above the **cap**: `findToolOnServer` returns nothing, so the answer is the generic
  `Tool not available: <name>` error, identical to a tool that does not exist. Tool lookup by
  name (`getServerByTool`, the aggregate `call_tool` search) skips such tools too, so the audit
  entry is the same row a missing tool leaves: server `unknown`, the full requested name, the
  same unavailable reason. A sleeping on-demand server is not woken for a tool the cached list
  shows to be above the cap or the ceiling.
- Above the **ceiling** but within the cap: the call is refused with the status shape used by
  Server Status: the message tells the user which level to allow, and
  `_meta["mcphub/status"] = { server, code: "risk_not_enabled", action: "enable_risk", risk }`.
  The audit entry's `statusCode` is `risk_not_enabled`, which My Activity reports as
  `blocked`.
- The cap is checked first, so a tool above both reveals nothing about the ceiling.

Search results and stored embeddings can be stripped copies without annotations, so the filter
reads annotations from the server's live tool of the same name; a tool nothing is known about
counts as `external` (fail closed).

Prompts and resources are not risk-filtered: the level is defined by tool annotations and
MCP has no equivalent for them.

## Persistence, authorization and exposure

`maxToolRisk` and `toolRiskOverrides` follow the Maintenance pattern: `Server` columns
(`maxToolRisk` varchar, `toolRiskOverrides` simple-json, both nullable) mapped in the database
DAO, copied by the JSON-to-database migration, excluded from templates, duplicates and the
settings-sync declaration and fingerprint. `riskCeiling` is a nullable column of the selection
table and a field of the sidecar record; it moves with the row on rename and migration and is
removed with the server or user. `save` of a selection never changes the ceiling and
`saveRiskCeiling` never changes `selected`.

Both server fields are administrator-only to write: any non-admin request that carries either
key (create, batch create, update), whatever the value, gets the same 403. They are also
administrator-only to read (the presenter drops them for owners, and the safe view never had
them). Users learn only the **effective** consequence: `GET /api/workspace/servers` reports
`riskCeiling`, `riskCounts` (tools within the cap, by effective level; `null`, with `toolCount: null`, for a
service needing personal credentials whose tools are not known until the user connects), `maxAllowedRisk` (the
cap that applies to the requester; `external` for administrators) and a `toolCount` that counts
only tools within the ceiling. Administrators additionally get each tool's
`{ computed, override, effective }` in the dashboard projection under Workspace Mode.

Validation: `maxToolRisk` accepts `read`, `write`, `external` (`external` and `null` store as
absent). `toolRiskOverrides` accepts levels only; against a tool the server currently lists,
a level below its computed one is rejected with 400, both on a server save and on
`PUT /api/servers/:server/tools/:tool/risk` (`{ risk }`, `null` clears). A tool the server does
not list cannot be checked then, but is clamped on every read.

`PUT /api/workspace/servers/:name/risk` (`{ riskCeiling }`) stores a user's ceiling for a
server they can see, does not change their selection, rejects a level above the cap with 400,
and notifies only that user's sessions. A change of the cap or an override notifies every open
session, since it applies whether or not the server was selected.

## Consequences

- **Turning Workspace Mode on hides tools.** Every selected server starts at `read`, so tools
  that change data or reach others, and every tool without annotations, disappear from users'
  lists until they allow more. The workspace page says so: a banner above the services counts
  the hidden tools, and each selected service shows its three levels with the number of tools
  at each, a note on how many its current choice hides, and options the administrator forbids
  disabled. An administrator cannot raise a user's ceiling for them: users must opt in, so expect
  questions about tools that "went missing" right after the mode is enabled.
- Many MCP servers do not annotate their tools; their tools are all `external` until the
  upstream is fixed (an override can only raise, never lower). This is the intended fail-safe
  and the main adoption cost.
- Like other in-memory server state, a cap or override edit is applied to the live entry of
  the instance that handled it; instances sharing a database converge on their next reload.
- A server that needs personal credentials has no shared tool list, so its tools are judged
  from the user's own runtime listing; a search hit for a tool that list has not shown yet is
  treated as `external`.
- The dashboard's own server list still shows owners the tools of their servers; the cap is a
  restriction on routes that expose or call tools, not on configuration views.
