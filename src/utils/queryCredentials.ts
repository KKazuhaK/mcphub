import type { SystemConfig } from '../types/index.js';

// Query-string names that carry a credential. Matched case-insensitively. Session identifiers
// (`sessionId`) and the dashboard's `keyId` filters are deliberately not here: they are not secrets.
const QUERY_CREDENTIAL_PARAMS = new Set([
  'token',
  'access_token',
  'auth_token',
  'bearer_token',
  'api_key',
  'apikey',
  'key',
  'authorization',
  'x-auth-token',
]);

/** `routing.allowTokenInQuery` defaults to true so existing clients keep working. */
export const isQueryTokenAllowed = (systemConfig?: SystemConfig | null): boolean =>
  systemConfig?.routing?.allowTokenInQuery !== false;

/** The name (never the value) of the first credential-like query parameter, if any. */
export const findQueryCredentialParam = (query: unknown): string | undefined => {
  if (!query || typeof query !== 'object') return undefined;
  return Object.keys(query as Record<string, unknown>).find((name) =>
    QUERY_CREDENTIAL_PARAMS.has(name.toLowerCase()),
  );
};

export const QUERY_CREDENTIAL_REJECTED_MESSAGE =
  'Credentials in the URL query string are not accepted; send them in a request header';

/** True when the request carries a query credential the current setting forbids. */
export const rejectsQueryCredential = (
  query: unknown,
  systemConfig?: SystemConfig | null,
): string | undefined =>
  isQueryTokenAllowed(systemConfig) ? undefined : findQueryCredentialParam(query);
