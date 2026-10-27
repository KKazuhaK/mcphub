import { ServerConfigValidationError } from './serverConfigValidation.js';

/**
 * `credentials:write:<serverName>`: an OAuth scope that lets one client write or delete the
 * signed-in user's own credential binding for exactly one server, and nothing else.
 * See docs/adr/0013-credential-write-scope.md.
 */
export const CREDENTIAL_WRITE_SCOPE_PREFIX = 'credentials:write:';

/** Access tokens carrying this scope live for five minutes and have no refresh token. */
export const CREDENTIAL_WRITE_TOKEN_LIFETIME_SECONDS = 300;

export const MAX_CREDENTIAL_WRITE_CLIENTS = 50;
const MAX_CLIENT_ID_LENGTH = 2048;

export const isCredentialWriteScope = (scope: string): boolean =>
  scope.startsWith(CREDENTIAL_WRITE_SCOPE_PREFIX);

/** The server name of a `credentials:write:<name>` scope, or null when it is not one. */
export const credentialWriteServerName = (scope: string): string | null => {
  if (!isCredentialWriteScope(scope)) return null;
  const name = scope.slice(CREDENTIAL_WRITE_SCOPE_PREFIX.length);
  return name.length > 0 ? name : null;
};

export const credentialWriteScopeFor = (serverName: string): string =>
  `${CREDENTIAL_WRITE_SCOPE_PREFIX}${serverName}`;

export const splitScopes = (scope: string | string[] | undefined | null): string[] => {
  if (!scope) return [];
  const list = Array.isArray(scope) ? scope : scope.split(' ');
  return list.map((s) => s.trim()).filter((s) => s.length > 0);
};

/** True when any scope in the set is a credential-write scope (alone or mixed). */
export const includesCredentialWriteScope = (
  scope: string | string[] | undefined | null,
): boolean => splitScopes(scope).some(isCredentialWriteScope);

/**
 * The single server a scope set is narrowed to, or null when the set is not exactly one
 * well-formed credential-write scope. A set that mixes it with anything else is never valid.
 */
export const soleCredentialWriteServer = (
  scope: string | string[] | undefined | null,
): string | null => {
  const scopes = splitScopes(scope);
  if (scopes.length !== 1) return null;
  return credentialWriteServerName(scopes[0]);
};

// `null` and `undefined` both mean "none" (a stored database row reads unset columns as null).
export const normalizeCredentialWriteClients = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ServerConfigValidationError(
      'credentialWriteClients must be an array of OAuth client ids',
    );
  }
  const clients = Array.from(
    new Set((value as string[]).map((item) => item.trim()).filter((item) => item.length > 0)),
  );
  if (clients.some((client) => client.length > MAX_CLIENT_ID_LENGTH)) {
    throw new ServerConfigValidationError(
      `credentialWriteClients entries must be at most ${MAX_CLIENT_ID_LENGTH} characters`,
    );
  }
  if (clients.length > MAX_CREDENTIAL_WRITE_CLIENTS) {
    throw new ServerConfigValidationError(
      `credentialWriteClients can list at most ${MAX_CREDENTIAL_WRITE_CLIENTS} clients`,
    );
  }
  return clients.length > 0 ? clients : undefined;
};
