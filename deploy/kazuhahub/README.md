> Superseded: do not deploy this custom Hub build. The selected architecture uses the official MCPHub image and an independent Canvas Portal. Use the [Portal deployment task](https://github.com/KKazuhaK/canvas-mcp/blob/kazuha/portal-official-hub/deploy/mcphub/PORTAL-SERVER-PROMPT.md) instead. Historical implementation retained for reference.

# Canvas credential reminders for MCPHub 1.1.10

This fork adds Canvas token expiration status and opt-in email reminders to personal credential bindings. It runs inside MCPHub; no standalone Canvas service is required. Back up the existing settings, credential store, encryption key, users, database and Compose environment before changing the image. Preserve all original mounts and environment variables. This feature adds no database columns: its state is stored inside each binding's existing authenticated ciphertext, supported by both file and database DAOs.

## Configuration

Add the variables in `canvas-reminders.env.example` to the existing container. `MCPHUB_CANVAS_ORIGINS` lists exact operator-approved HTTPS institution origins, such as `https://canvas.eee.uci.edu`, separated by commas. User URL fields accept either that institution origin or `/api/v1`; queries, fragments and user-info URLs are rejected by expiration discovery. Only approved origins receive the saved Canvas token for metadata checks. DNS and socket addresses are checked against public-network rules and redirects are disabled.

`MCPHUB_PUBLIC_URL` is the externally reachable HTTPS Hub base URL, including any base path. SMTP uses port 587 with mandatory STARTTLS by default; for implicit TLS use port 465 and `MCPHUB_SMTP_SECURE=true`. Certificate verification stays enabled. Configure a sender address authorized by the mail provider. SMTP credentials stay in a server-local environment file with restrictive permissions and must not be committed, included in screenshots, printed or pasted into chats. Existing authentication, OAuth, credential encryption and reverse-proxy configuration must stay intact.

## User setup and behavior

Existing bindings continue to work. In Dashboard → Credentials, Canvas bindings expose expiration status, a reminder checkbox, days before expiration (default 7, range 1–90), optional manual date and an immediate Canvas metadata refresh. Refresh and reminder changes use the existing binding; no token re-entry is required. Users must opt in; existing users are not silently subscribed. Their MCPHub account must have an email. Delivery always targets the binding owner's current account email; this feature accepts no arbitrary email recipient. The page warns when the account lacks email or SMTP configuration is absent.

The service checks at startup and hourly without dashboard visits. Automatic metadata is refreshed at most daily. It verifies the Canvas profile user, token hint or exact visible mask, timezone-bearing expiration, and distinguishes an explicit non-expiring token from unknown metadata. Canvas does not expose token metadata on every institution: unknown remains unknown until an operator approves the origin, discovery succeeds, or the user enters a manual date. Failed refreshes retain a previously verified or manual date for the same binding, so an expired token's 401 cannot suppress its already-known expiration reminder.

A binding receives one soon-to-expire and one expired reminder per expiration date. Persisted delivery claims prevent ordinary concurrent worker duplicates; SMTP failure retries on a later hourly pass. SMTP acceptance followed by a process crash before persistence can cause a duplicate: this is not exactly-once delivery. The file DAO requires one MCPHub process on one writable persistent settings volume; for multiple processes use the database DAO. User deletion, access revocation, opt-out, binding deletion or replacement stops subsequent deliveries. Replacing a token resets metadata and opt-in; enable reminders again for the replacement. Already accepted email cannot be recalled.

## Deployment and verification

Build this branch's pinned commit with the repository Dockerfile (`INSTALL_EXT=false`), assign a unique local image tag and change only the MCPHub service image in the existing Compose project. Keep a backup of the old image ID and Compose/env files for rollback. Recreate only that service, without deleting volumes or unrelated services. Verify health, sign-in, OAuth discovery, existing binding status, Canvas's 48 tools, Anteater's 20 tools, and any other configured servers.

Enable reminders in the owner's own Canvas binding after verifying SMTP and account email, then refresh expiration. If Canvas returns unknown, manually enter the real date. Do not shorten a production expiry merely to force a test: use an isolated temporary binding/test deployment and the owner's own mailbox. Report metadata verification and actual SMTP inbox delivery separately. Existing reminders from the retired standalone service are not automatically imported.

Rollback changes only the service image and any added environment variables, retaining the data and credential key. Unknown encrypted metadata is ignored by unmodified 1.1.10. Keep the backup until production checks pass. This fork is based on 1.1.10 and needs future upstream updates to be reviewed and rebuilt; switching back to the stock image removes reminder behavior.

## Upgrades

This is an independent custom build, version `1.1.10-kazuhahub.1`. Pulling the official image removes the reminder feature while keeping ordinary credentials usable. Do not configure automatic replacement with the upstream `latest` image. For a future upstream upgrade, port the three new `canvas*` service modules and their controller, credential-status, startup and frontend/locale integration, rerun the tests and build, then deploy a new pinned image with backup and rollback. Persisted encrypted reminder metadata is backward-compatible but stock images do not run the reminder scheduler.

For completely independent upstream image upgrades, a separate reminder sidecar with its own authenticated credential registration is an alternative architecture. It is not included in this implementation.

UI verification used synthetic data only, with no SMTP sends: [desktop](screenshots/reminder-desktop.png) and [mobile, 390×844 with sidebar collapsed](screenshots/reminder-mobile.png).
