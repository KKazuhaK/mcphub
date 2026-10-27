import { resolveUserSession } from './userSession.js';
import { isOAuthServerEnabled } from '../services/oauthServerService.js';
import { getToken as getOAuthStoredToken } from '../models/OAuth.js';
import { IUser, SystemConfig } from '../types/index.js';
import { safeCompare } from './safeCompare.js';
import { getCachedSystemConfig } from './systemConfigCache.js';
import { isOAuthTokenIdle } from '../services/connectedClientService.js';
import { getBearerTokenFromHeaders, parseBearerAuthorization } from './bearerAuth.js';
import { includesCredentialWriteScope, soleCredentialWriteServer } from './credentialWriteScope.js';
import { evaluateCredentialWriteScopes } from '../services/credentialWriteScopeService.js';

// Three base64url segments: the shape of every JWT, including the access tokens MCPHub signs for
// external resources (ADR 0014). MCPHub's own OAuth tokens are opaque hex and never contain a dot.
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * Resolve the user and OAuth client behind a raw OAuth bearer token.
 *
 * A JWT is never one: the access tokens MCPHub issues for external resources are for another
 * audience, and the record behind them holds an internal id that is never disclosed.
 */
export const resolveOAuthGrantFromToken = async (
  token?: string,
): Promise<{ user: IUser; clientId: string } | null> => {
  if (!token || !isOAuthServerEnabled() || JWT_SHAPE.test(token)) {
    return null;
  }

  const oauthToken = await getOAuthStoredToken(token);
  if (!oauthToken || !safeCompare(oauthToken.accessToken, token)) {
    return null;
  }

  // A grant issued for an external resource is not a bearer for MCPHub's own routes.
  if (oauthToken.resource) {
    return null;
  }

  // A credential-write token only ever opens the two credential endpoints (see
  // resolveCredentialWriteGrantFromToken); it is not a bearer for MCP routes.
  if (includesCredentialWriteScope(oauthToken.scope)) {
    return null;
  }

  // A grant idle past the workspace window is refused exactly like a revoked token.
  if (isOAuthTokenIdle(oauthToken, getCachedSystemConfig())) {
    return null;
  }

  const dbUser = await resolveUserSession(oauthToken);
  if (!dbUser) return null;

  return {
    user: {
      username: oauthToken.username,
      password: '',
      isAdmin: dbUser?.isAdmin || false,
    },
    clientId: oauthToken.clientId,
  };
};

export type CredentialWriteGrant = {
  username: string;
  clientId: string;
  serverName: string;
};

/**
 * Resolve a raw bearer token to a credential-write grant: the token's own user, its client and
 * the one server it is narrowed to. Anything else is null - another kind of OAuth token, a
 * refresh token, a token whose scope is mixed or malformed, or one whose client or server is
 * no longer eligible. Admin status is deliberately not read: it never widens this grant.
 */
export const resolveCredentialWriteGrantFromToken = async (
  token?: string,
): Promise<CredentialWriteGrant | null> => {
  if (!token || !isOAuthServerEnabled() || JWT_SHAPE.test(token)) {
    return null;
  }

  const oauthToken = await getOAuthStoredToken(token);
  // Only the access token is a bearer: a presented refresh token never matches here.
  if (!oauthToken || !safeCompare(oauthToken.accessToken, token) || oauthToken.resource) {
    return null;
  }

  const serverName = soleCredentialWriteServer(oauthToken.scope);
  if (!serverName) {
    return null;
  }

  const evaluation = await evaluateCredentialWriteScopes(oauthToken.clientId, oauthToken.scope);
  if (evaluation.kind !== 'granted') {
    return null;
  }

  return { username: oauthToken.username, clientId: oauthToken.clientId, serverName };
};

/**
 * Resolve an MCPHub user from a raw OAuth bearer token.
 */
export const resolveOAuthUserFromToken = async (token?: string): Promise<IUser | null> =>
  (await resolveOAuthGrantFromToken(token))?.user ?? null;

/**
 * Resolve an MCPHub user from the configured bearer auth header.
 */
export const resolveOAuthUserFromAuthHeader = async (
  authHeader?: string,
): Promise<IUser | null> => {
  const token = parseBearerAuthorization(authHeader);
  if (!token) {
    return null;
  }

  return resolveOAuthUserFromToken(token);
};

/**
 * Resolve an MCPHub user from request headers using the configured bearer auth header name.
 */
export const resolveOAuthUserFromHeaders = async (
  headers: Record<string, string | string[] | undefined>,
  systemConfig?: SystemConfig | null,
): Promise<IUser | null> => {
  const token = getBearerTokenFromHeaders(headers, systemConfig);
  return resolveOAuthUserFromToken(token || undefined);
};
