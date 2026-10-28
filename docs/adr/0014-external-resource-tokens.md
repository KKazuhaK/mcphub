# JWT access tokens for external protected resources

Status: implemented. Nothing changes for a deployment that never sets `oauthServer.externalResources`,
except that `jwks_uri` appears in the authorization-server metadata and a `resource` that is neither
one of MCPHub's own routes nor configured is now refused (see "Resource matching").

## Context

An external service (the UBC connector) protects its own MCP endpoint with tokens issued by MCPHub's
authorization server. Until now every MCPHub access token was an opaque random string that only
MCPHub can look up, so such a service had to call back into MCPHub internals to learn who a token
belonged to, and had to trust whatever MCPHub answered. The remediation direction (3.3) is the
opposite: services trust a configurable, standard issuer and validate tokens themselves, offline,
with off-the-shelf tools.

## Decision

MCPHub's authorization server can issue **JWT access tokens (RFC 9068) for configured external
resources**, bound with RFC 8707 `resource`. The service verifies them with the issuer and the JWKS
from the standard metadata (`jwks_uri`). MCPHub's own opaque tokens, and every MCPHub route, are
unchanged.

### Configuration

`systemConfig.oauthServer.externalResources: Array<{ resource, name, allowedClients? }>`, settable
only through `PUT /api/system-config`, which is administrator-only (a non-admin gets 403 before
anything is read). `resource` is an absolute https URL (http only for `localhost`, `127.0.0.1`,
`[::1]`) with no fragment or credentials; entries are validated and unique. `name` is shown on the
consent screen and in connected clients. `allowedClients` lists OAuth client ids; empty or absent
means any registered client.

### Resource matching

A `resource` parameter (authorization request, token request, or both) is classified once:

1. **Exactly equal** (byte for byte, no normalisation of case, trailing slash or query) to a
   configured `resource`, and the client is allowed: **external**.
2. A URL on MCPHub's own origin (the issuer, or the host the request arrived on): **own**. Handled
   exactly as before: the value is only shown on the consent screen and the token is opaque.
   When the public URL is not configured (`install.baseUrl` / `INSTALL_BASE_URL` unset), MCPHub may
   sit behind a proxy that rewrites the host, so it cannot judge origins; a URL shaped like one of
   its MCP routes (`/mcp`, `/mcp/<name>`, `/<user>/mcp/...`) then counts as own whatever the origin,
   as every such deployment relied on before. Configure the public URL to get the strict check.
3. Anything else, a resource the client may not use, several `resource` values, or a non-string:
   **`invalid_target`** (RFC 8707 section 2).

A disallowed client and an unknown resource get the same error text, so a response never reveals
which resources are configured. The error is `invalid_target` rather than `access_denied`: RFC 8707
defines it for "invalid, missing, unknown or malformed" resources, and `access_denied` is for a
resource owner's decision, which no one made. At `/oauth/authorize` it is a redirect to the client
(with `state` and `iss`) and no consent page is shown; at `/oauth/token` it is a 400 JSON error.

An external resource must be named at `/oauth/authorize`, where the consent screen shows its
configured name and exact URL, and is bound to the code. At `/oauth/token` a `resource` is accepted
only if it equals the code's bound resource: a code with no binding (or one authorized for an own
route) can never yield an external JWT, whatever the token request says. The refusal is
`invalid_target`, with the text an unknown resource gets, and happens before the code is spent. The
client's `allowedClients` entry is re-checked at that point, so a client that was removed after
consent is refused identically. An external resource cannot be combined with the
`credentials:write:*` scope (ADR 0013).

### The token

Header `alg: ES256`, `kid`, `typ: at+jwt`. Claims: `iss` (exactly the `issuer` of
`/.well-known/oauth-authorization-server`), `aud` (the resource URL, a string), `sub` (the MCPHub
username), `client_id`, `scope` (space separated, may be empty), `iat`, `exp` (the smaller of
`oauthServer.accessTokenLifetime` and `oauthServer.externalTokenLifetimeSeconds`, default 900), `jti`.

External tokens are issued only when the public base URL is configured (`install.baseUrl` or
`INSTALL_BASE_URL`); otherwise `iss` would follow the request's Host header, which a verifier cannot
trust, and authorization fails with `server_error`. The issuer has one spelling (no trailing slash)
in the metadata `issuer`, every `iss` claim, the RFC 9207 `iss` parameter and `jwks_uri`.

The refresh token stays an **opaque** MCPHub refresh token, bound to the same resource. Refreshing
yields a new JWT for the same resource only; a refresh request cannot name a different resource or
add one to an unbound grant.

### Not a bearer for MCPHub

The client receives the JWT, but the stored OAuth record keeps a random internal id as its
`accessToken` that is never disclosed and is marked with the resource. MCPHub's bearer resolvers
(`resolveOAuthGrantFromToken`, the credential-write resolver, `/oauth/userinfo`) refuse any
JWT-shaped value before a lookup and any record that carries a resource. The audience is not
MCPHub, so even a misconfigured forward-auth (ADR 0005) trusting MCPHub as an issuer would need
`aud` to match its own audience.

### Keys and the JWKS

`GET /.well-known/jwks.json` publishes **public keys only** (explicitly `kty, crv, x, y, kid, alg,
use`); `jwks_uri` is added to the metadata. Keys are ES256 (P-256), generated on first need, with
`kid` the RFC 7638 thumbprint. When external resources are configured the key is created by the
first JWKS request, so a verifier never sees an empty set ahead of its first token.

Storage and encryption:

- **JSON mode**: a sidecar `<settings file>.oauth-signing-keys.json`, mode 0600, written atomically.
- **Database mode**: the `oauth_signing_keys` table (`kid`, `public_jwk`, `private_key`, `created_at`,
  `activate_at`, `retired_at`).
- The private key (PKCS#8) is sealed with **AES-256-GCM using the credential encryption key**
  (`MCPHUB_CREDENTIAL_ENCRYPTION_KEY` or its local key file, created the same way the credential
  binding service creates it), with the `kid` as additional authenticated data (`enc:v1....`).
  There is no plaintext fallback: if the encryption key is configured but unusable, no key is
  generated and no token is issued (logged, `server_error`).
- Key material is never in an API response, a settings export or a log line.

Unlocking failures never trigger replacement. If the current key cannot be unlocked (the encryption
key changed or was lost), external tokens are refused with an error log and the public keys stay
published so earlier tokens verify. Read paths (JWKS, signing) never create, retire or replace
keys; the only generation besides the very first key is the explicit administrator rotation. The
first key is created once (single-flight), by the first JWKS request or the first token; a failure
is not retried for a minute, so unauthenticated JWKS requests cannot loop on it.

Rotation, `POST /api/oauth/signing-keys/rotate` (administrator only, key ids in the response):

1. A **next** key is created and published in the JWKS immediately.
2. It starts signing only after `oauthServer.signingKeyActivationDelaySeconds` (default 900, longer
   than common JWKS caches and `jose`'s 30 s refetch cooldown), so verifiers learn it before
   their first token arrives. The current key signs meanwhile. Activation is automatic and checked
   lazily when signing; the superseded key is then retired. A key that never activated is replaced
   by a newer rotation. With no usable current key the new key signs at once.
3. A retired key stays published until `retired_at + accessTokenLifetime + 5 minutes`, then the next
   rotation deletes it.

Rotation is manual; there is no automatic schedule.

### Revocation

External services validate offline, so MCPHub cannot recall an issued JWT. Mitigations:

- the lifetime is short by construction: `min(accessTokenLifetime, externalTokenLifetimeSeconds)`,
  default 15 minutes, without touching the lifetime of MCPHub's own tokens;
- revoking a user's or a client's grants (the Connected Clients paths, user offboarding, deleting a
  client) deletes the refresh token, so no new JWT can be minted;
- removing a resource, or a client from its `allowedClients`, stops refreshes at once;
- rotating the signing key and dropping the old one ends everything it signed immediately (the
  emergency option).

### Connected clients

The grant is listed as the client with the resource name (`UBC Connector (UBC Courses)`) plus a
`resources` array. Issuing a token counts as the grant's use for idle expiry, since MCPHub never sees
the JWT again.

## Why not the alternatives

- **Introspection (RFC 7662).** Needs MCPHub reachable and trusted on every request, which is what
  this removes; it also needs client authentication for each service.
- **Make every token a JWT.** MCPHub validates its own tokens by lookup, which gives instant
  revocation. Only tokens for other audiences need offline validation.
- **A symmetric (HS256) key shared with the service.** Any holder could mint tokens.
- **Accept the JWT on MCPHub routes too.** It is for another audience; the separation is the point.

## Consequences and limits

- **Release note:** the authorization-server metadata `issuer` (and the RFC 9207 `iss` parameter, the
  other endpoint URLs and `authorization_servers` in the protected-resource metadata) no longer
  carries a trailing slash when the configured base URL ends in `/`. Clients that compared the old
  spelling literally must use the discovered value.
- An own `resource` repeated at the token or refresh endpoint (as MCP SDKs do) is accepted for any
  grant without an external binding and yields the usual opaque token.

- With the public URL configured, a client that sends a `resource` on neither MCPHub's origin nor the
  configured list is now refused where it used to be ignored. Without it, an unlisted URL that looks
  like an MCP route (for example a service's own `/mcp`) is still accepted as "own" and gets an
  opaque token that service will not accept. External JWTs themselves require the public URL.
- A deployment behind a proxy that rewrites the host without `INSTALL_BASE_URL` should set it, so
  the `iss` in the token equals the issuer a verifier discovers.
- The earlier known limitation stands: a client registered with a secret cannot complete
  `/oauth/authorize` (ADR 0013); use a public client with PKCE S256.
