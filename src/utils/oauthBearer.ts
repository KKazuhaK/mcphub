import { resolveUserSession } from './userSession.js';
import { isOAuthServerEnabled } from '../services/oauthServerService.js';
import { getToken as getOAuthStoredToken } from '../models/OAuth.js';
import { IUser, SystemConfig } from '../types/index.js';
import { safeCompare } from './safeCompare.js';
import { getCachedSystemConfig } from './systemConfigCache.js';
import { isOAuthTokenIdle } from '../services/connectedClientService.js';
import { getBearerTokenFromHeaders, parseBearerAuthorization } from './bearerAuth.js';

/**
 * Resolve the user and OAuth client behind a raw OAuth bearer token.
 */
export const resolveOAuthGrantFromToken = async (
  token?: string,
): Promise<{ user: IUser; clientId: string } | null> => {
  if (!token || !isOAuthServerEnabled()) {
    return null;
  }

  const oauthToken = await getOAuthStoredToken(token);
  if (!oauthToken || !safeCompare(oauthToken.accessToken, token)) {
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
