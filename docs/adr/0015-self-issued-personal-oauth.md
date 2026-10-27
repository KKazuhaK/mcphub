# MCPHub as the authorization server of its own upstream

Status: implemented.

## Context

ADR 0014 lets MCPHub issue audience-bound JWT access tokens for an external resource (for example
the UBC connector's `/mcp`). The same MCPHub should be able to call that service for each user, using
its existing personal OAuth identity mode, without holding any service-specific credential.

## Decision

A server with `oauth.identityMode: 'personal'` whose `url` is exactly an
`oauthServer.externalResources[].resource` (public base URL configured, authorization server enabled,
no explicit `authorizationServerMetadata`, `authorizationEndpoint` or `tokenEndpoint`) is a
**self-resource server**. Nothing else is configured; the SDK client flow runs unchanged:

- **Discovery and `resource`.** The MCP SDK client reads the upstream's `WWW-Authenticate`
  `resource_metadata`, then RFC 9728 `authorization_servers`, and sends the metadata's `resource` at
  authorize, code exchange and refresh. The administrator's `url` must therefore equal the
  upstream's metadata `resource` (which ADR 0014 already matches byte for byte).
- **Issuer pin.** The discovered issuer must equal MCPHub's own (the configured public base URL);
  otherwise the flow fails. The upstream cannot redirect the user to a different server.
- **Client.** MCPHub's own public client `mcphub-personal-oauth` is created through the DAO (no HTTP
  registration, no secret). Its redirect URIs are always exactly one: `<public base URL>/oauth/callback`.
  A server's own `oauth.redirectUri` or registration `redirect_uris` are ignored for a self-resource
  server, so nothing a server's owner controls can add a destination to the shared client. The record
  is healed on every connect (public: secret cleared with an explicit `null`, so a database merge
  cannot keep it; the two grants; the single redirect URI replaced, never unioned) and the dashboard
  API refuses to edit, delete or give it a secret (409). It is never reaped (no `clientIdIssuedAt`).
  The only server-controlled value that decides wiring is `url` (plus opt-outs below); `oauth.clientId`
  other than this id, explicit endpoints or explicit `authorizationServerMetadata` leave the server on
  its own configuration. If the entry's `allowedClients` is non-empty it must include the client; the
  connect then fails with an administrator-facing message naming the entry. One client id serves every
  self-resource server, so revoking it as a Connected Client ends all of that user's self-issued grants.
- **Reserved id.** A server may name `oauth.clientId: mcphub-personal-oauth` only when its url is an
  external resource (saving it otherwise is a 400, on create, update, batch and template import; a
  definition that slipped through is refused at connect), so no server can borrow the first-party
  consent name.
- **Scopes.** The provider requests none itself, but the SDK falls back to the service's advertised
  scopes. For a request naming an external resource MCPHub grants only the scopes listed in that
  entry's `scopes` (admin-configured, copied into the JWT `scope` claim); any other requested scope is
  dropped, not refused, and an entry without a list grants none. MCPHub's own `read`/`write` are never
  granted for an external resource.
- **Self loop.** Requests for MCPHub's own `/.well-known/oauth-authorization-server` and
  `/oauth/token` are served by a dedicated minimal app on `127.0.0.1` (ephemeral port) that mounts only
  those two handlers, with its own rate limits shared with no public traffic: one per user and server (keyed by a hash
  the in-process fetch adds) and a generous ceiling over all of them. They are selected by
  origin and path against the public base URL. Nothing is sent to the public URL and the SSRF guard
  is not involved. Authorization (consent) stays in the user's browser at the public URL. The upstream
  resource and its metadata use the normal guarded fetch.
- **Storage and refresh.** The grant is stored as for any personal OAuth server (per user, encrypted
  binding), together with the `resource` it was made for (`grantResource`). The SDK refreshes on a 401
  with the bound `resource`; MCPHub's refresh token is opaque and stays bound to it.
- **Disconnect and reconnect.** MCPHub publishes no revocation endpoint, so disconnecting (and
  starting a new connection) deletes every record of (user, public client, resource) on its own
  authorization server, for the configured resource and the stored `grantResource`. Access tokens
  already issued are JWTs verified offline and stay valid until they expire, at most
  `externalTokenLifetimeSeconds` (default 900) after the disconnect. Revoking the client in Connected
  Clients makes the next refresh fail with `invalid_grant`, which the workspace reports as the
  credential being rejected.

## Limits

- Only `streamable-http` upstreams are wired (the SSE transport is not).
- A reverse proxy that strips a path prefix from the public URL is handled by matching the issuer
  path; other rewrites are not.
- The loopback listener is an extra 127.0.0.1 socket; it serves only the two routes above.
