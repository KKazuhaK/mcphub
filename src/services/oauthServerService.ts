import { getUserSessionVersion, resolveUserSession } from '../utils/userSession.js';
import OAuth2Server from '@node-oauth/oauth2-server';
import { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { getSystemConfigDao } from '../dao/index.js';
import { findUserByUsername, verifyPassword } from '../models/User.js';
import {
  findOAuthClientById,
  saveAuthorizationCode,
  getAuthorizationCode,
  revokeAuthorizationCode,
  saveToken,
  getToken,
  revokeToken,
} from '../models/OAuth.js';
import crypto from 'crypto';
import { safeCompare } from '../utils/safeCompare.js';
import { cloneDefaultOAuthServerConfig } from '../constants/oauthServerDefaults.js';
import { resolveCimdClient } from './cimdClientService.js';
import { logger } from '../utils/logger.js';
import { getCachedSystemConfig } from '../utils/systemConfigCache.js';
import { isOAuthTokenIdle, oauthGrantCreatedAt } from './connectedClientService.js';
import { getRevocationSeq, isGrantRevokedSince } from '../utils/grantRevocation.js';
import {
  CREDENTIAL_WRITE_TOKEN_LIFETIME_SECONDS,
  credentialWriteScopeFor,
  includesCredentialWriteScope,
  isCredentialWriteScope,
  soleCredentialWriteServer,
} from '../utils/credentialWriteScope.js';
import { evaluateCredentialWriteScopes } from './credentialWriteScopeService.js';

const { Request, Response } = OAuth2Server;

// OAuth2Server model implementation
const oauthModel: OAuth2Server.AuthorizationCodeModel & OAuth2Server.RefreshTokenModel = {
  /**
   * Get client by client ID
   *
   * Confidential clients (a secret is registered) MUST always present their
   * secret, even when the global requireClientSecret toggle is off — that
   * toggle only permits secret-less PUBLIC clients (GHSA-3m7m).
   */
  getClient: async (clientId: string, clientSecret?: string) => {
    let client = await findOAuthClientById(clientId);

    // CIMD fallback: URL-shaped client_ids resolve to public clients via their
    // metadata document (opt-in). They never carry a secret, so the strict
    // secret check below is a no-op for them.
    if (!client) {
      const cimdClient = await resolveCimdClient(clientId);
      if (cimdClient) {
        client = {
          clientId: cimdClient.clientId,
          name: cimdClient.name,
          redirectUris: cimdClient.redirectUris,
          grants: cimdClient.grants,
          metadata: cimdClient.metadata,
        };
      }
    }

    if (!client) {
      return false;
    }

    // If the registered client has a secret, it must be presented and match.
    if (client.clientSecret) {
      if (!clientSecret || !safeCompare(client.clientSecret, clientSecret)) {
        return false;
      }
    }

    return {
      id: client.clientId,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      redirectUris: client.redirectUris,
      grants: client.grants,
    };
  },

  /**
   * Save authorization code
   *
   * Public clients (no registered secret) MUST use PKCE with the S256 method:
   * without this, an intercepted code could be redeemed by anyone (GHSA-3m7m).
   */
  saveAuthorizationCode: async (
    code: OAuth2Server.AuthorizationCode,
    client: OAuth2Server.Client,
    user: OAuth2Server.User,
  ) => {
    if (!client.clientSecret) {
      if (!code.codeChallenge || code.codeChallengeMethod !== 'S256') {
        throw new OAuth2Server.InvalidRequestError(
          'PKCE with code_challenge_method=S256 is required for public clients',
        );
      }
    }

    const systemConfigDao = getSystemConfigDao();
    const systemConfig = await systemConfigDao.get();
    const oauthConfig = systemConfig?.oauthServer;
    const lifetime = oauthConfig?.authorizationCodeLifetime || 300;

    const scopeString = Array.isArray(code.scope) ? code.scope.join(' ') : code.scope;

    const currentUser = await resolveUserSession(user);
    if (!currentUser) throw new OAuth2Server.InvalidGrantError('User no longer exists');
    const sessionVersion = getUserSessionVersion(currentUser);

    const authCode = saveAuthorizationCode(
      {
        redirectUri: code.redirectUri,
        scope: scopeString,
        clientId: client.id,
        username: user.username,
        sessionVersion,
        codeChallenge: code.codeChallenge,
        codeChallengeMethod: code.codeChallengeMethod,
      },
      lifetime,
    );

    return {
      authorizationCode: authCode,
      expiresAt: new Date(Date.now() + lifetime * 1000),
      redirectUri: code.redirectUri,
      scope: code.scope,
      client,
      user: {
        username: user.username,
      },
      codeChallenge: code.codeChallenge,
      codeChallengeMethod: code.codeChallengeMethod,
    };
  },

  /**
   * Get authorization code
   */
  getAuthorizationCode: async (authorizationCode: string) => {
    const code = getAuthorizationCode(authorizationCode);
    if (!code || !(await resolveUserSession(code))) {
      return false;
    }

    const client = await findOAuthClientById(code.clientId);
    if (!client) {
      return false;
    }

    const scopeArray = code.scope ? code.scope.split(' ') : undefined;

    return {
      authorizationCode: code.code,
      expiresAt: code.expiresAt,
      redirectUri: code.redirectUri,
      scope: scopeArray,
      client: {
        id: client.clientId,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUris: client.redirectUris,
        grants: client.grants,
      },
      user: {
        username: code.username,
        sessionVersion: code.sessionVersion,
        exchangeSeq: getRevocationSeq(),
      },
      codeChallenge: code.codeChallenge,
      codeChallengeMethod: code.codeChallengeMethod,
    };
  },

  /**
   * Revoke authorization code
   */
  revokeAuthorizationCode: async (code: OAuth2Server.AuthorizationCode) => {
    revokeAuthorizationCode(code.authorizationCode);
    return true;
  },

  /**
   * Save access token and refresh token
   */
  saveToken: async (
    token: OAuth2Server.Token,
    client: OAuth2Server.Client,
    user: OAuth2Server.User,
  ) => {
    const systemConfigDao = getSystemConfigDao();
    const systemConfig = await systemConfigDao.get();
    const oauthConfig = systemConfig?.oauthServer;
    let accessTokenLifetime = oauthConfig?.accessTokenLifetime || 3600;
    let refreshTokenLifetime: number | undefined = oauthConfig?.refreshTokenLifetime || 1209600;

    const scopeString = Array.isArray(token.scope) ? token.scope.join(' ') : token.scope;

    // A credential-write token is narrow and used at once: five minutes at most and never a
    // refresh token, so a leaked one cannot be renewed. It is never saved alongside other scopes.
    if (includesCredentialWriteScope(scopeString)) {
      if (!soleCredentialWriteServer(scopeString)) {
        throw new OAuth2Server.InvalidScopeError(
          'Invalid scope: credentials:write cannot be combined with other scopes',
        );
      }
      accessTokenLifetime = Math.min(accessTokenLifetime, CREDENTIAL_WRITE_TOKEN_LIFETIME_SECONDS);
      refreshTokenLifetime = undefined;
    }

    if (!(await resolveUserSession(user))) {
      throw new OAuth2Server.InvalidGrantError('User session is no longer valid');
    }

    // A revoke of this (user, client) after the exchange read its grant wins over the exchange.
    const exchangeSeq = typeof user.exchangeSeq === 'number' ? user.exchangeSeq : undefined;
    const revokedMeanwhile = () =>
      exchangeSeq !== undefined && isGrantRevokedSince(user.username, client.id, exchangeSeq);
    if (revokedMeanwhile()) {
      throw new OAuth2Server.InvalidGrantError('The authorization was revoked');
    }

    const savedToken = await saveToken(
      {
        scope: scopeString,
        clientId: client.id,
        username: user.username,
        sessionVersion: user.sessionVersion,
        // Only a refresh grant's user carries these (see getRefreshToken): the rotated
        // record keeps the grant's creation and last-use time instead of starting over.
        grantCreatedAt: typeof user.grantCreatedAt === 'string' ? user.grantCreatedAt : undefined,
        lastUsedAt: typeof user.lastUsedAt === 'string' ? user.lastUsedAt : undefined,
      },
      accessTokenLifetime,
      refreshTokenLifetime,
    );

    // The revoke can also land between the check and the write: take the new token back.
    if (revokedMeanwhile()) {
      await revokeToken(savedToken.accessToken);
      throw new OAuth2Server.InvalidGrantError('The authorization was revoked');
    }

    const scopeArray = savedToken.scope ? savedToken.scope.split(' ') : undefined;

    return {
      accessToken: savedToken.accessToken,
      accessTokenExpiresAt: savedToken.accessTokenExpiresAt,
      refreshToken: savedToken.refreshToken,
      refreshTokenExpiresAt: savedToken.refreshTokenExpiresAt,
      scope: scopeArray,
      client,
      user: {
        username: user.username,
      },
    };
  },

  /**
   * Get access token
   */
  getAccessToken: async (accessToken: string) => {
    const token = await getToken(accessToken);
    if (!token) {
      return false;
    }
    // Also guards /oauth/userinfo: an idle grant is refused like a revoked one.
    if (isOAuthTokenIdle(token, getCachedSystemConfig())) {
      return false;
    }

    const client = await findOAuthClientById(token.clientId);
    if (!client) {
      return false;
    }

    // A credential-write token stops working the moment its client or server is no longer
    // eligible, including on /oauth/userinfo.
    if (
      includesCredentialWriteScope(token.scope) &&
      (await evaluateCredentialWriteScopes(token.clientId, token.scope)).kind !== 'granted'
    ) {
      return false;
    }

    const scopeArray = token.scope ? token.scope.split(' ') : undefined;

    return {
      accessToken: token.accessToken,
      accessTokenExpiresAt: token.accessTokenExpiresAt,
      scope: scopeArray,
      client: {
        id: client.clientId,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUris: client.redirectUris,
        grants: client.grants,
      },
      user: {
        username: token.username,
        sessionVersion: token.sessionVersion,
      },
    };
  },

  /**
   * Get refresh token
   */
  getRefreshToken: async (refreshToken: string) => {
    const token = await getToken(refreshToken);
    if (!token || !token.refreshToken || !safeCompare(token.refreshToken, refreshToken)) {
      return false;
    }
    if (isOAuthTokenIdle(token, getCachedSystemConfig())) {
      return false;
    }
    // Credential-write grants are never refreshable.
    if (includesCredentialWriteScope(token.scope)) {
      return false;
    }

    const client = await findOAuthClientById(token.clientId);
    if (!client) {
      return false;
    }

    const scopeArray = token.scope ? token.scope.split(' ') : undefined;

    return {
      refreshToken: token.refreshToken!,
      refreshTokenExpiresAt: token.refreshTokenExpiresAt!,
      scope: scopeArray,
      client: {
        id: client.clientId,
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        redirectUris: client.redirectUris,
        grants: client.grants,
      },
      user: {
        username: token.username,
        sessionVersion: token.sessionVersion,
        // A record from before grants were dated keeps the age it already has.
        grantCreatedAt:
          token.grantCreatedAt ??
          new Date(oauthGrantCreatedAt(token, getCachedSystemConfig())).toISOString(),
        lastUsedAt: token.lastUsedAt,
        exchangeSeq: getRevocationSeq(),
      },
    };
  },

  /**
   * Revoke token
   */
  revokeToken: async (token: OAuth2Server.Token | OAuth2Server.RefreshToken) => {
    const refreshToken = 'refreshToken' in token ? token.refreshToken : undefined;
    if (refreshToken) {
      await revokeToken(refreshToken);
    }
    return true;
  },

  /**
   * Verify scope
   */
  verifyScope: async (token: OAuth2Server.Token, scope: string | string[]) => {
    if (!token.scope) {
      return false;
    }

    const requestedScopes = Array.isArray(scope) ? scope : scope.split(' ');
    const tokenScopes = Array.isArray(token.scope)
      ? token.scope
      : (token.scope as string).split(' ');

    return requestedScopes.every((s) => tokenScopes.includes(s));
  },

  /**
   * Validate scope
   */
  validateScope: async (user: OAuth2Server.User, client: OAuth2Server.Client, scope?: string[]) => {
    const systemConfigDao = getSystemConfigDao();
    const systemConfig = await systemConfigDao.get();
    const oauthConfig = systemConfig?.oauthServer;
    // Credential-write is never a default or configurable scope: it is granted only when asked
    // for explicitly, on its own, for a server that lists this client.
    const allowedScopes = (oauthConfig?.allowedScopes || ['read', 'write']).filter(
      (s) => !isCredentialWriteScope(s),
    );

    if (scope && scope.some(isCredentialWriteScope)) {
      const evaluation = await evaluateCredentialWriteScopes(client.id, scope);
      return evaluation.kind === 'granted'
        ? [credentialWriteScopeFor(evaluation.serverName)]
        : false;
    }

    if (!scope || scope.length === 0) {
      return allowedScopes;
    }

    const validScopes = scope.filter((s) => allowedScopes.includes(s));

    return validScopes.length > 0 ? validScopes : false;
  },
};

// Create OAuth2 server instance
let oauth: OAuth2Server | null = null;

/**
 * Initialize OAuth server
 */
export const initOAuthServer = async (): Promise<void> => {
  // Reset to ensure clean state on re-initialization
  oauth = null;

  const systemConfigDao = getSystemConfigDao();
  const systemConfig = await systemConfigDao.get();
  const storedConfig = systemConfig?.oauthServer;
  // Merge stored config with defaults so partial configs still inherit all default values
  const oauthConfig = { ...cloneDefaultOAuthServerConfig(), ...storedConfig };
  const requireState = oauthConfig.requireState === true;

  if (!oauthConfig.enabled) {
    logger.log('OAuth authorization server is disabled');
    return;
  }

  try {
    oauth = new OAuth2Server({
      model: oauthModel,
      accessTokenLifetime: oauthConfig.accessTokenLifetime || 3600,
      refreshTokenLifetime: oauthConfig.refreshTokenLifetime || 1209600,
      authorizationCodeLifetime: oauthConfig.authorizationCodeLifetime || 300,
      allowEmptyState: !requireState,
      allowBearerTokensInQueryString: false,
      // When requireClientSecret is false, allow PKCE without client secret
      requireClientAuthentication: oauthConfig.requireClientSecret
        ? { authorization_code: true, refresh_token: true }
        : { authorization_code: false, refresh_token: false },
    });

    logger.log('OAuth authorization server initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize OAuth authorization server:', error);
    oauth = null;
  }
};

/**
 * Get OAuth server instance
 */
export const getOAuthServer = (): OAuth2Server | null => {
  return oauth;
};

/**
 * Check if OAuth server is enabled
 */
export const isOAuthServerEnabled = (): boolean => {
  return oauth !== null;
};

/**
 * Authenticate user for OAuth authorization
 */
export const authenticateUser = async (
  username: string,
  password: string,
): Promise<OAuth2Server.User | null> => {
  const user = await findUserByUsername(username);
  if (!user) {
    return null;
  }

  const isValid = await verifyPassword(password, user.password);
  if (!isValid) {
    return null;
  }

  return {
    username: user.username,
    isAdmin: user.isAdmin,
    sessionVersion: getUserSessionVersion(user),
  };
};

/**
 * Generate PKCE code verifier
 */
export const generateCodeVerifier = (): string => {
  return crypto.randomBytes(32).toString('base64url');
};

/**
 * Generate PKCE code challenge from verifier
 */
export const generateCodeChallenge = (verifier: string): string => {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
};

/**
 * Test seam: the OAuth2Server model implementation. Exposed so unit tests can
 * verify per-client authentication and PKCE policy directly.
 */
export const getOAuthModel = (): typeof oauthModel => oauthModel;

/**
 * Handle OAuth authorize request
 */
export const handleAuthorizeRequest = async (
  req: ExpressRequest,
  res: ExpressResponse,
): Promise<OAuth2Server.AuthorizationCode> => {
  if (!oauth) {
    throw new Error('OAuth server not initialized');
  }

  const request = new Request(req);
  const response = new Response(res);

  return await oauth.authorize(request, response);
};

/**
 * Handle OAuth token request
 */
export const handleTokenRequest = async (
  req: ExpressRequest,
  res: ExpressResponse,
): Promise<OAuth2Server.Token> => {
  if (!oauth) {
    throw new Error('OAuth server not initialized');
  }

  const request = new Request(req);
  const response = new Response(res);

  return await oauth.token(request, response);
};

/**
 * Handle OAuth authenticate request (validate access token)
 */
export const handleAuthenticateRequest = async (
  req: ExpressRequest,
  res: ExpressResponse,
): Promise<OAuth2Server.Token> => {
  if (!oauth) {
    throw new Error('OAuth server not initialized');
  }

  const request = new Request(req);
  const response = new Response(res);

  return await oauth.authenticate(request, response);
};
