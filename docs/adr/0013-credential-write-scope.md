# A narrow OAuth scope for writing one server's personal credentials

Status: implemented. Applies with Workspace Mode on or off; nothing changes for a deployment
that never sets `credentialWriteClients`.

## Context

An external service that collects a user's personal credentials for a server (the UBC
connector) had to forward the user's MCPHub session cookie to call
`PUT /api/credentials/:name`. A session cookie is everything the user can do: the connector, or
anything that leaked its copy, could manage servers, read settings, or act as an administrator if
the user is one. The credential API only ever needed one narrow ability.

## Decision

A new OAuth scope, `credentials:write:<serverName>`, requested through the normal authorization
code flow with PKCE S256 at `/oauth/authorize` and exchanged at `/oauth/token`. The resulting
access token can do exactly two things, for the **token's own user** and the **one named server**:

- `PUT /api/credentials/<serverName>` with `{ "values": { "<slotId>": "<value>" } }`: the same
  validation, destination fingerprint (ADR 0011) and notification as a dashboard save;
- `DELETE /api/credentials/<serverName>`.

`GET /oauth/userinfo` keeps working with it (`sub` is the username).

### Who may request it

A new administrator-only server field, `credentialWriteClients: string[]`, lists the OAuth client
ids allowed to request `credentials:write:<this server>`. The scope is valid only when all of
these hold, and is otherwise refused with `invalid_scope`:

- it was requested **explicitly**; it is never part of the default scopes, and a pattern scope
  placed in `oauthServer.allowedScopes` is ignored;
- it is requested **alone**: any combination with another scope, or with a second
  `credentials:write:*`, is refused at authorize time;
- the server exists, has a credential template, and lists the requesting client.

The field follows the other administrator-only server fields (ADR 0007, 0010): a non-admin
request that carries the key at all gets a constant 403, it is hidden from every non-admin
including the owner, it is excluded from templates, duplicates and the settings-sync declaration
and fingerprint, it is persisted in JSON and database modes and carried by the first-boot
migration. It is configurable through the server API (`PUT /api/servers/:name`) by an
administrator; the dashboard form has no control for it yet.

The same check runs again at the token exchange and on **every request the token makes**, so
removing a client from the list, removing the server's slots, or deleting the server ends the
token at once, including on `/oauth/userinfo`.

### How the token is kept narrow

- `resolveOAuthGrantFromToken`, the single resolver behind MCP routes (Streamable HTTP, SSE,
  messages, per-user routes), refuses any token whose scope contains a credential-write scope. It
  is not a bearer for MCP.
- The shared `/api` authentication gate (`middlewares/auth.ts`) honours such a token only for
  `PUT` or `DELETE` on `/credentials/<name>`, and answers 403 when `<name>` is not the server in
  the token. The principal it produces is the token's user with `isAdmin: false` and a
  `credentialWriteGrant` marker, whatever the user's real role: administrator status never
  widens the token. On every other `/api` route the token is simply not a credential (401), and
  `GET /api/credentials` refuses a principal that carries the marker as a second line of defence.
- Only the access token authenticates: a refresh token presented as a bearer never matches.
- The username comes from the token, never from the URL or body, so one user's token cannot touch
  another user's binding.

### Lifetime

The access token lives at most five minutes (`CREDENTIAL_WRITE_TOKEN_LIFETIME_SECONDS`, bounded
by the configured access-token lifetime) and **no refresh token is issued**: the model's
`saveToken` simply does not create one for this scope, so the token response has no
`refresh_token`, and `getRefreshToken` refuses such a grant as a second line of defence. The
connector obtains a token and uses it immediately.

### Consent

The consent page shows one sentence, "`<client>` wants to set your personal credentials for
`<server>`" (`oauthServer.credentialWrite`, in all six locales), instead of the scope list and
without the resource box. The fallback server-rendered page does the same. A request that cannot
be granted never reaches the consent page: `GET /oauth/authorize` redirects to the client with
`error=invalid_scope`.

### Audit and notification

Each write or delete through this scope logs `user`, `client` and `server` (no values, no
validation messages) and, in database mode, adds an activity row (`tool` is `credentials.write` or
`credentials.delete`, `clientKind` `oauth`, `clientId`, payloads omitted as for any
credential-templated server). A failed attempt is recorded with status `error`. The existing
notifier runs after a successful write, so a user's open sessions refresh under Workspace Mode.

### Metadata

`scopes_supported` in the authorization-server metadata is unchanged: a per-server pattern is not
advertised, so strict clients that validate requests against the list are unaffected.

## Why not the alternatives

- **Keep forwarding the session cookie.** Rejected: full user authority for a one-field job.
- **A static API key for the connector.** Rejected: it cannot say which user is writing, so the
  connector would have to be trusted with an arbitrary username.
- **A general `credentials:write` scope.** Rejected: one leaked token could overwrite every
  server's binding. Naming the server in the scope puts the least privilege in the token itself
  and in the consent text the user reads.

## Direction

This is the first step towards standard MCP authorization for personal credentials (the "U3-B"
direction): the connector authenticates as an OAuth client on behalf of the user, and MCPHub
decides what that client may do from the scope rather than from a borrowed session.

## Known limitation

A client registered with a secret cannot currently complete `/oauth/authorize`: the OAuth library
looks the client up without a secret at that step and the model refuses a confidential client that
does not present one (`invalid_client`). This predates the scope and is unchanged here; use a
public client with PKCE S256 until that is addressed.
