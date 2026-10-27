# Personal credentials are bound to the destination they were entered for

Status: implemented. Applies with and without Workspace Mode.

## Decision

Each credential-slot binding stores a keyed fingerprint of the destination-relevant parts
of the server declaration at save time (`destinationFingerprint`). A request resolves a
binding only when the stored fingerprint equals the one computed from the current
declaration. Otherwise the binding is treated as missing: `resolveCredentialBinding`
throws `StaleCredentialError` before any value is read into the runtime config, so the
values reach neither the environment, the headers, the URL nor the arguments of the
upstream connection. The error is a `MissingCredentialError`, so everything that handles
a missing credential still applies; in Workspace Mode the status is `needs_auth` with
`reason: "destination_changed"` and its own message ("the connection settings changed;
enter your credentials again"), told apart from "never configured".

Bindings are never deleted by this. The user re-entering values overwrites the binding
with the current fingerprint; deleting the server still deletes its bindings.

## Why this exception to "Workspace Mode off behaves as before"

Without the check, anyone who can edit a server (an administrator, or its owner) can
point it at a host or command they control and receive every user's stored secret on
the next call. Personal OAuth already refused this (#1362); credential slots did not.
This is a security fix to an existing feature, so it is not gated by Workspace Mode. The
only observable change with the mode off is that a binding made against a destination
that has since moved asks the user to enter their values again.

## Fingerprint

Canonical JSON (sorted keys, array order kept) of: transport type; `url`; headers other
than those a slot fills (each kept as sent, sorted by lower-cased then original name, so a
hidden duplicate differing only in case changes the value); `command`; `args` with slot
placeholders as written; `env` other than the variables a slot fills (names and values:
env can redirect traffic, e.g. `HTTPS_PROXY`); `proxy` (proxychains); `openapi.url`,
`openapi.schema`, `openapi.security`, `openapi.specSecurity`; and the sorted slot
targets and names.

Not included: description, visibility, sharing, `enabled`, `tools`/`prompts`/`resources`
settings, `options` (timeouts), keep-alive, on-demand and idle settings,
`passthroughHeaders`, `perSessionClient`, pause, maintenance and tool-risk fields, the
owner (ownership is an authorization question), slot labels, and URL slots' `allowed`
lists (a stored URL value must still be on the list to be used, so widening it moves
nothing and narrowing it already makes the binding unconfigured). `ServerConfig` has no
working-directory, TLS or agent option today; one added later must be added to the list.

There is one fingerprint function. Every path (save, status, runtime resolution, startup
stamping and the administrator's before/after comparison) takes the **stored definition** and
runs it through `expandServerConfig`, always, exactly once, then reduces it to the fields
above. Expansion also trims whitespace, so skipping it on some paths would make them
disagree; no shortcut is taken for configs without `$`. The status path loads the stored
definition itself rather than trusting a config its caller holds, which can be a personal
runtime's resolved copy with URL-slot values substituted.

The value is `v1:` plus an HMAC-SHA-256 under the credential encryption key, so the
stored column reveals nothing about URLs, header values or env (which can hold secrets)
and cannot be recomputed without the key. A plain hash would let anyone with read access
to the table test guesses against a known declaration. Losing the key already loses the
bindings, so keying adds no new dependency.

## Relation to personal OAuth

Personal OAuth keeps its own check, `declarationOAuth` in `personalOAuthService.ts`: type,
URL and the OAuth client/endpoint metadata, stored inside the encrypted values. The two
lists are deliberately different. OAuth tokens are issued by an authorization server for a
client and resource, so only those fields bind them; changing the list would invalidate
every existing personal OAuth connection on upgrade, so it is left as is. The two share
only the canonical JSON helper (`canonicalJson.ts`), which produces byte-identical output
to the previous private copy. A slot-based server cannot also use OAuth (it is rejected),
so a binding is covered by exactly one of the two. Known difference: personal OAuth does
not cover headers, env or proxy; tightening that is a separate decision because it would
reset existing connections.

## Upgrade: startup stamping

Bindings without a fingerprint are legacy. One pass at startup, before any request is served,
stamps each with the fingerprint of its server's current declaration using a conditional
write (`adoptDestinationFingerprint`: update where the fingerprint is null and the ciphertext
is the one that was read), so instances starting together cannot overwrite each other. The
ciphertext does not change, so runtime revisions are unaffected. A binding whose server no
longer exists is marked `v1:orphaned` (kept, never matching); one that cannot be decrypted is
skipped; rows of servers that take no slots (personal OAuth) are left alone.

After the pass nothing is adopted on first use, and a binding without a fingerprint is stale.
The earlier design (adopt on first use) would have bound a legacy credential to whatever
destination a server had at that moment, including one changed before anyone used it.

The residual window is the time between the last run of the old version and the first run of
this one: a destination changed in that interval (a file edit while stopped) is stamped as the
new destination. A server created under a name that still has bindings (dashboard, batch and
template import) marks them orphaned at creation, before the server exists, so a re-created
server never inherits an earlier server's credentials. Settings sync and file load do not
orphan: on a first database boot the migration copies bindings before the sync inserts the
servers, and the startup pass already orphans bindings of servers that are missing.

## OpenAPI origin

An OpenAPI server's tool calls go to the `servers` entry of its document, which can differ
from the declared document URL and, for a remote document, can change without the
declaration changing. For a credential-slot OpenAPI server whose document is given by URL,
the request's origin (scheme, host, port) must equal the origin of that URL before any slot
value is attached; otherwise the call is refused with `DestinationMismatchError` (a missing
credential, `reason: "destination_mismatch"`), logged, before any DNS or network activity.
There is no separate base-URL option to declare another origin. An inline schema is part of
the declaration and its fingerprint, so it is not checked. Consequence: such a server whose
API legitimately lives on a different host than its document needs the document served from
that host or given inline.

## Multiple instances

Instances sharing a database must expand `${VAR}` references identically: a destination field
that resolves to a per-pod value gives each pod a different fingerprint, so bindings saved on
one pod are stale on the others. Keep such values out of destination fields or identical across
pods.

During a rolling upgrade, bindings saved by instances still running the old version carry no
fingerprint and stay stale until an instance of the new version restarts and runs the startup
pass. Upgrade all instances together.

## Encryption key

The fingerprint is an HMAC under the credential encryption key. Replacing the key makes every
binding undecryptable and every stored fingerprint unverifiable, so users enter their
credentials again; there is no migration of fingerprints across keys.

## Admin edit path and notification

Before an edit is applied, `PUT /api/servers/:name` lists the users whose binding is valid for
the stored declaration. After it, if the destination moved, the response (still
`success: true`) carries `credentialsReset: true` and a translated warning. Administrators also
get `credentialsAffected: N` and a message with the count; an owner who is not an administrator
gets a warning without any count, so the number of users holding credentials for a server is
not disclosed. Only bindings that were valid before the edit are counted. The hub logs a
warning with the count only, and the dashboard shows the warning. The save is never blocked
and a failure computing the notice never fails it. Under Workspace Mode the affected users'
own sessions get a list-changed notification through the targeted notifier.

## Personal runtimes are not rebuilt from the shared definition

A reconnect or on-demand wake of a runtime that takes personal credentials throws instead of
reloading the stored definition, which holds no credential values.

## Persistence

`credential_bindings.destinationFingerprint`: nullable `varchar(80)`, JSON field of
`StoredCredentialBinding`, copied by the JSON-to-database migration, never exported
(bindings are not part of any settings export). A rename keeps bindings only when the
connection did not change (existing behaviour); the fingerprint does not include the
server name, so kept bindings stay valid.

## Consequences

- An administrator who edits a destination field on a server with bound users invalidates
  every user's credentials for it. This is the intent; the response says how many.
- A change that restores the previous declaration makes the bindings valid again, since
  they were never deleted.
- Settings sync and direct file edits change fingerprints without a warning; users find
  out at their next call, with the "settings changed" message.
- Binding data is only trustworthy while the credential store is: the fingerprint column is
  not part of the ciphertext's associated data, so someone able to write the table could stamp
  a row. That access already yields the ciphertext, and the key is needed to read it.
- A non-credential field read through `expandServerConfig` (environment expansion)
  changes with the process environment: changing an environment variable that a
  `${VAR}` reference resolves to invalidates bindings of servers that reference it.
