# MCPHub

Domain glossary for MCPHub — a hub that aggregates multiple MCP servers behind a single HTTP/SSE surface. This file is the canonical source for project-specific vocabulary; use these terms (and avoid the listed synonyms) in code, issues, and UI copy.

## Language

**Definition Cost**:
The number of tokens a single exposed item (a Tool, Prompt, or Resource) adds to a model's context window when its definition is listed to that model. For a tool, measured over its name, description, and complete input schema; for prompts and resources, over their listed definition fields. An estimate, not a billed figure, because the true count depends on the consuming client's model and framing. A tool's Definition Cost is dominated by its input schema.
_Avoid_: token size, tool weight, context usage

**Context Footprint**:
The total Definition Cost a Server or Group imposes on a connecting client, reported as a pair of co-equal numbers: its Exposed Footprint and its Gross Footprint. This is what the cost feature surfaces per Server and per Group.
_Avoid_: total cost, total size, token total

**Exposed Footprint**:
The Context Footprint counting only the items a client actually receives — for a Server, its enabled items; for a Group, the items each member server has selected into that group (and enabled). The number you actually pay.
_Avoid_: effective cost, net cost

**Gross Footprint**:
The Context Footprint counting every item a Server reports, ignoring enabled/selection state — the maximum potential cost. For a Group, the sum of its member servers' Gross Footprints. Shown alongside Exposed Footprint so the savings from curation are visible.
_Avoid_: total cost, raw cost, full cost

**Connection Mode**:
How a client consumes a Group or all-servers scope, which determines what definitions it registers: **Direct** (registers every exposed item's definition — costs the Exposed Footprint) or **Smart Routing** (registers only Meta-tools — costs the Smart Routing Footprint). The cost feature reports a number per applicable mode.
_Avoid_: routing type, access mode

**Meta-tool**:
One of the fixed scaffolding tools Smart Routing registers in place of the underlying tools: `search_tools` and `call_tool` always, plus `describe_tool` under Progressive Disclosure or when `fullSchemaTopN` limits which search hits carry a schema. A Meta-tool's definition is not constant — its description embeds the in-scope server names and group name, so its Definition Cost varies slightly by scope.
_Avoid_: virtual tool, proxy tool, system tool

**Smart Routing Footprint**:
The Context Footprint of a scope under Smart Routing — the summed Definition Cost of its Meta-tool set (two Meta-tools normally, three under Progressive Disclosure or with `fullSchemaTopN` set) as constructed for that scope, plus that of its Pinned Tools. Far smaller than the Direct/Exposed Footprint; this contrast is the feature's headline value.
_Avoid_: smart cost, routing cost

**Pinned Tool**:
A tool a Group lists by name on its `$smart/{group}` endpoint next to the Meta-tools, chosen per member server with `pinnedTools`. It is still searchable and callable through the Meta-tools; pinning only saves the `search_tools` round trip for a tool used in nearly every session.
_Avoid_: hot tool, always-exposed tool, favourite

**Progressive Disclosure**:
A global Smart Routing mode that adds the `describe_tool` Meta-tool and keeps tool schemas out of search results, fetching them on demand. It raises the upfront Smart Routing Footprint by one Meta-tool while shrinking each search response — a trade this feature measures only on the upfront (definition) side.
_Avoid_: lazy disclosure, deferred schema, PD (in UI copy)

**Workspace Mode**:
The `systemConfig.workspace.enabled` setting. When on, each user curates their own MCP scope by selecting servers; when off, MCPHub routes exactly as it did before the setting existed.
_Avoid_: portal mode, user mode

**Server Selection**:
A user's explicit choice to include one visible server in their own MCP scope, stored per (user, server). Absent means not selected. Selection only narrows what visibility already allows; it never grants access. It applies to the all-servers route, global `$smart`, and single-server routes for an authenticated user under Workspace Mode, never to admin-defined Group routes or dashboard calls.
_Avoid_: subscription, enablement (reserved for the global `enabled` flag), favourite

**Personal Endpoint**:
A user's all-servers MCP route (`/:user/mcp`, or `/:user/mcp/$smart` under Smart Routing). Under Workspace Mode it exposes exactly that user's selected, visible, enabled servers, so its URL stays the same while the selection changes.
_Avoid_: personal URL (ambiguous with personal URL credential slots), aggregate endpoint

**Server Status**:
What one user would meet calling one visible server under Workspace Mode: a stable `code` (`available`, `not_selected`, `paused`, `maintenance`, `needs_auth`, `revoked`, `credential_invalid`, `error`), a short message, and the `action` that resolves it (`select`, `connect`, `contact_admin`, `retry_later`, or none). Reported for servers the user can see only; a server they cannot see keeps the generic "not available" answer. `paused` is the global `enabled` flag or the user being listed in the server's `pausedUsers`; `maintenance` is an active admin maintenance window; `revoked` means the user disconnected personal OAuth; `credential_invalid` and recorded `error` describe the user's most recent attempt, never block a call, and heal on the next success.
_Avoid_: health, availability (ambiguous with the shared connection state)

**Maintenance**:
An admin-set window on one server (`maintenance: { until?, message? }`, admin-only to write) during which every requester except administrators, including system keys, sees it as `maintenance` and cannot list or call it, on every route including admin group routes and dashboard calls, while the upstream stays connected. It ends by itself when `until` passes; nothing is written to end it. Effective only under Workspace Mode.
_Avoid_: downtime, disabled (reserved for the global `enabled` flag)

**Per-user Pause**:
A server's `pausedUsers` list: the server is `paused` for the listed usernames only (administrators included) on every route, and unaffected for everyone else. Readable and writable by admins only. An access control, not a selection. Effective only under Workspace Mode.
_Avoid_: block, ban, per-user disable

**Connected Client**:
Anything that can act as one user on MCP routes: an OAuth client holding a live access or refresh token for that user from MCPHub's own authorization server (one entry per client and user, however many tokens it has rotated through), or a user-level bearer key the user owns. A user lists and revokes their own under Workspace Mode (`/api/workspace/clients`); revoking one leaves their other clients and their endpoint URL unchanged. Each records a last-use time, and one unused for `workspace.clientIdleDays` (default 90, 0 off, measured from no earlier than the moment the mode was enabled) is refused like a revoked one.
_Avoid_: session (a live MCP connection opened by a client), integration, app

**My Activity**:
A user's own call history under Workspace Mode (`GET /api/workspace/activity`, database mode only): which Connected Client called which tool of which service, when, how long it took, and whether it succeeded, failed or was blocked by a Server Status. Metadata only: tool input and output are never returned, nor is the recorded error text (a failure is a fixed category such as `upstream_error`; a blocked call carries its status code). The view shows the last `workspace.activityRetentionDays` (default 90); only an explicit administrator `activityLog.retentionDays` ever deletes activity.
_Avoid_: audit log (the admin view, which keeps payloads when configured), usage

**Tool Risk Level**:
How far a tool's effects reach, derived from its standard MCP annotations and ordered `read` < `write` < `external`. `read`: `readOnlyHint` is true. `write`: not read-only and `openWorldHint` is false (changes only the user's own data). `external`: everything else, including a tool with no annotations at all. Annotations are believed only for servers an administrator owns; every tool of any other server is `external`. An administrator can only raise a tool's level (`toolRiskOverrides`), never lower it. Prompts and resources have no level and are never filtered by it. Effective only under Workspace Mode.
_Avoid_: permission, danger level, sensitivity

**Risk Ceiling**:
The highest Tool Risk Level a user allows on one server, stored per (user, server) next to the Server Selection; until they choose it is the server's admin-set `defaultUserRisk` (never above the Risk Cap), else `read`. It is the user's own choice, so it applies exactly where Server Selection does (never to admin Group routes or dashboard calls); a tool above it is left out of lists, `$smart` search, `describe_tool` and pinned tools, and a call to it is refused with `_meta["mcphub/status"]` `{ server, code: "risk_not_enabled", action: "enable_risk", risk }`.
_Avoid_: tool permission, allowlist

**Risk Cap**:
An administrator's `maxToolRisk` on one server (absent means no cap). An access control like Maintenance: it applies on every route, for lists and calls, to every requester except administrators (a request without a user is not exempt). A tool above it is as good as nonexistent: the refusal is the generic "not available" error, byte for byte. Where both apply, the user is held to the lower of the Risk Cap and their Risk Ceiling, and the cap is checked first so it never reveals itself through the ceiling. Admin-only to write and to read.
_Avoid_: tool limit, maximum permission
