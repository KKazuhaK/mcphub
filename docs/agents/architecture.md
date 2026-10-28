# Architecture and data/auth invariants

Read this guide when changing runtime wiring, MCP connections, HTTP routing, authentication, persistence, or database behavior. For the public runtime overview, see [docs/development/architecture.mdx](../development/architecture.mdx).

## Runtime map

- `src/index.ts` starts the process and `src/server.ts` owns `AppServer` initialization, route registration, and shutdown.
- `src/services/mcpService.ts` owns the lifecycle of upstream MCP clients.
- `src/routes/` defines HTTP routes; `src/controllers/` implements resource handlers.
- `src/dao/` provides file-backed persistence by default; `src/db/` provides the optional TypeORM/PostgreSQL backend.
- `src/clients/` contains upstream MCP client wrappers.
- `src/types/` contains shared configuration and domain types.
- `frontend/src/` contains the Vite/React dashboard.

## Persistence changes

When adding or changing a persisted field, update every applicable layer:

1. `src/types/index.ts` — shared interface or schema.
2. `src/dao/*Dao.ts` — JSON implementation when behavior changes.
3. `src/db/entities/*.ts` — TypeORM column; mark optional fields `nullable` and use `simple-json` for object values.
4. `src/dao/*DaoDbImpl.ts` — database create/update mapping.
5. `src/db/repositories/*.ts` — repository wrapper, when it exposes the field.
6. `src/utils/migration.ts` — JSON-to-database migration.
7. `mcp_settings.json` — example configuration, when user-facing.

Database mode is selected at startup by the code in `src/dao/DaoFactory.ts`: `USE_DB=true` enables it; when `USE_DB` is unset, a configured `DB_URL` enables it; an explicit `USE_DB=false` disables it.

## Bearer-key invariant

Bearer keys have explicit kinds. Legacy and operator-created keys use `kind: 'system'`; user-level keys use `kind: 'user'` and must have an `owner`. Do not infer the kind from whether `owner` is empty. User-level keys restore the owner's live user context on MCP transport requests and are not dashboard API credentials.

Bearer-key tokens are never stored: `BearerKey` holds `tokenHash` (SHA-256, constant-time compared) and a display `tokenPrefix`. `token` exists only on the object `create()` returns, which is the one response that shows it. DAOs hash a plaintext `token` they are given, JSON reads and `migrateLegacyTokens()` (run at startup) hash plaintext left by older versions in place, and settings exports and key lists omit the token and the hash. Authentication compares `tokenHash` through `bearerHashMatches`; never compare or log `token`. See [ADR 0012](../adr/0012-security-hardening.md).

## Logging and redaction

Anything that can reach a log line, an activity row or an error message goes through `src/utils/redaction.ts` (URLs, headers, env, args, bodies) or the logger, which applies it by key name (`url`, `headers`, `env`, `args`) and to error objects. A resolved credential slot is registered in `resolvedCredentialValues`; `collectConfigSecrets(config)` lists every value to scrub for that runtime. A new place that logs a URL, a request, a child-process argument or an upstream response must use these helpers. `routing.allowTokenInQuery=false` rejects query-string credentials on MCP, SSE and `/api` routes.

## The credential-write scope stays narrow

A token whose scope contains `credentials:write:*` is honoured only by the `/api` gate in `src/middlewares/auth.ts`, only for `PUT`/`DELETE /credentials/<its server>`, and as a non-admin principal carrying `credentialWriteGrant`. `resolveOAuthGrantFromToken` must keep refusing it, so it never authenticates an MCP route. Never read the user's admin status when serving it, never accept it beside another scope, and re-check the client against the server's `credentialWriteClients` on every request. See [ADR 0013](../adr/0013-credential-write-scope.md).

## External-resource tokens are not MCPHub bearers

A token issued for a configured external resource (`oauthServer.externalResources`) is a signed JWT for another audience; its stored record keeps an undisclosed internal id and a `resource`. `resolveOAuthGrantFromToken`, the credential-write resolver and the `getAccessToken` model hook must keep refusing JWT-shaped values and any record with a `resource`, so such a token never authenticates an MCP route or an API. The `resource` request parameter is classified once by `classifyResource` (exact match, own origin, else `invalid_target`), a grant stays bound to its resource across refresh, and signing-key material (`oauth_signing_keys`, the `.oauth-signing-keys.json` sidecar) stays out of every API, export and log. See [ADR 0014](../adr/0014-external-resource-tokens.md).

## Personal credentials follow their destination

A credential-slot binding stores `destinationFingerprint` (see `src/utils/credentialDestination.ts` for the exact field list). A binding whose fingerprint differs from the current declaration must never be injected: `resolveCredentialBinding` throws `StaleCredentialError` (a `MissingCredentialError`) before reading any value. Any new `ServerConfig` option that changes where traffic goes (a proxy, TLS or agent option, a working directory) belongs in that list. The binding functions take the stored definition and expand it themselves, once, through `expandServerConfig` (never skip it, never pass an already expanded or resolved config); startup runs `stampLegacyBindings`, and a binding without a fingerprint is stale. Applies with Workspace Mode off too; see [ADR 0011](../adr/0011-credential-destination-binding.md).

## Routing surface

- `/mcp/{group|server}` routes to a group, server, or `$smart`. `SMART_ROUTING_PATH` adds a reserved alias for `$smart`; transport middleware normalizes the alias before authentication while preserving the original OAuth resource URL.
- `/:user/mcp/{group|server}` and `/:user/sse/{group}` are user-scoped variants.
- `AppServer.initialize()` in `src/server.ts` is the route-registration entry point.
- Authentication spans dashboard JWT/bcrypt, bearer keys, MCPHub's OAuth authorization server, and optional Better Auth. Inspect the current middleware and route code before changing auth behavior.

## Declarative database configuration

`MCPHUB_SETTINGS_SYNC=upsert|prune` reconciles server/group declarations at startup only; see `src/utils/settingsSync.ts`. Keep runtime authentication state outside reconciliation. Internal sync ownership markers and the server declaration fingerprint must stay out of public DAO mappings and settings exports; unchanged declarations retain upstream OAuth state, while changes invalidate it. Pruning deletes only managed entries in explicitly supplied collections, with associated cleanup in the same transaction.
