# Security hardening: hashed bearer keys, header-only credentials, log redaction

Status: implemented. Applies with Workspace Mode on or off.

## Decision

**Bearer keys are stored as a SHA-256 hash.** A key keeps `tokenHash` (hex SHA-256 of the token)
and `tokenPrefix` (the first 8 characters, fewer for very short legacy tokens). The plaintext is
returned by the create call once and is never persisted, listed or exported. Lookup is by hash with
a constant-time comparison.

A keyed HMAC was considered and rejected: the only server secret, `JWT_SECRET`, is generated
afresh on every start when unset, so an HMAC under it would invalidate every key on restart. The
tokens MCPHub generates carry 256 random bits, so an unsalted digest cannot be brute-forced; a
legacy short, human-chosen token is only as strong as it was before.

**Migration.** Both modes hash plaintext in a startup migration. JSON mode never writes on a
read: until the startup migration has persisted the hashes, reads compute them in memory, and a
failed startup write logs a warning and leaves requests unaffected. Database mode hashes rows at
startup (`UPDATE ... WHERE id AND token = <plaintext>`, so a concurrent instance is not
overwritten) and, only until that migration has completed, authenticates an unmigrated row by its
derived hash. The legacy `routing.bearerAuthKey` is a one-time migration source and is blanked once
migrated or superseded; it is no longer settable through the system-config API. Both modes are
idempotent and write only when something changed. No log line carries a token.

**`routing.allowTokenInQuery`** (default `true`, so nothing changes until an operator opts in).
When `false`, a query string carrying `token`, `access_token`, `auth_token`, `bearer_token`,
`api_key`, `apikey`, `key`, `authorization` or `x-auth-token` is answered `401` on MCP, SSE,
user-scoped SSE, `/api` and the OAuth consent page, even if a valid header is also sent. The
dashboard log stream, which uses `EventSource`, switches to a header-based fetch reader. The Workspace
Mode endpoint snippets already put the URL and a header placeholder side by side; no snippet puts a
token in a URL.

**Redaction.** One module, `src/utils/redaction.ts`, owns URL (userinfo, query values, fragment),
header, env, argument and body redaction. The logger applies it by key name and to error objects
(an error whose message or attached request config carries something is logged as a sanitized
copy). Resolved credential-slot values are registered per runtime config and scrubbed literally
from upstream errors, child-process stderr and connect failures, including the host-label and
path-segment forms a URL slot produces.

**Database mode and the settings file.** In database mode `mcp_settings.json` is a migration
source and MCPHub does not rewrite it. If it still holds plaintext `bearerKeys[].token` or
`routing.bearerAuthKey` after they were moved into the database, startup logs a warning (never the
values) telling the operator to remove them.

**OAuth consent without a token in a URL.** A browser navigation to `/oauth/authorize` cannot
carry a header, so one flow serves both settings: a request that carries no credential (no
header, no session cookie, no accepted query token) is served the consent page unauthenticated
(`needsSession`) instead of being redirected to login. The SPA signs in with the session it
stores: it sends the user to login when there is none (login returns to the same token-free URL;
it never appends `?token=`), resolves the resource's real kind with an authenticated JSON
request, and submits the decision with `fetch` and an `x-auth-token` header; the server returns
the redirect target as JSON only for requests carrying that header. `?token=` on an existing
external link is still honoured while `allowTokenInQuery` is `true` and answered `401` when
`false`. Without the dashboard the old fallback applies (login redirect when allowed, `401`
otherwise). The dashboard log stream always uses a header-based fetch reader and stops on `401`
until the user signs in again.

## Consequences

- **Hashing is one-way.** Versions before this change cannot authenticate a hashed key (they
  compare plaintext). Rolling back requires restoring a database or settings backup taken before
  the upgrade, or creating new keys. In database mode every instance sharing the database must be
  upgraded together: an old instance still running cannot authenticate the migrated rows.

- Operators cannot recover a lost key; they create a new one.
- A restored database dump from before the migration still contains plaintext until the next start.
- Redacting every query value in logs loses diagnostic detail such as `lang=en`; parameter names stay.
