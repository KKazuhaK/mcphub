import { resolveJwtUser } from '../utils/userSession.js';
import { Request, Response, NextFunction } from 'express';
import defaultConfig from '../config/index.js';
import { getBearerKeyDao, getSystemConfigDao } from '../dao/index.js';
import { BearerKey, SystemConfig } from '../types/index.js';
import { getBetterAuthRuntimeConfig } from '../services/betterAuthConfig.js';
import { authenticateForwardAuthToken } from '../services/forwardAuthService.js';
import { bearerHashMatches, hashBearerToken } from '../utils/bearerKeyHash.js';
import { getBearerTokenFromHeaders } from '../utils/bearerAuth.js';
import { resolveCredentialWriteGrantFromToken } from '../utils/oauthBearer.js';
import { logger } from '../utils/logger.js';
import {
  QUERY_CREDENTIAL_REJECTED_MESSAGE,
  rejectsQueryCredential,
} from '../utils/queryCredentials.js';

const isTestEnv =
  process.env.NODE_ENV === 'test' ||
  process.env.JEST_WORKER_ID !== undefined ||
  process.env.VITEST_WORKER_ID !== undefined;

const resolveBetterAuthUserSafe = async (req: Request) => {
  if (isTestEnv) {
    return null;
  }

  const module = await import('../services/betterAuthSession.js');
  return module.resolveBetterAuthUser(req);
};

const validateBearerAuth = async (
  req: Request,
  systemConfig?: SystemConfig | null,
): Promise<BearerKey | null> => {
  const enableBearerAuth = systemConfig?.routing?.enableBearerAuth ?? true;
  if (!enableBearerAuth) {
    return null;
  }

  const bearerKeyDao = getBearerKeyDao();
  const enabledKeys = await bearerKeyDao.findEnabled();

  // If there are no enabled keys, bearer auth via static keys is disabled
  if (enabledKeys.length === 0) {
    return null;
  }

  const token = getBearerTokenFromHeaders(req.headers, systemConfig);
  if (!token) {
    return null;
  }

  const presentedHash = hashBearerToken(token);
  const matchingKey: BearerKey | undefined = enabledKeys.find((key) =>
    bearerHashMatches(key.tokenHash, presentedHash),
  );
  if (!matchingKey) {
    logger.warn('Bearer auth failed: token did not match any configured bearer key');
    return null;
  }

  // Dashboard/API bearer authentication grants access to non-MCP management routes.
  // Scoped keys are enforced on MCP routes in sseService.ts and must not bypass
  // dashboard API authorization.
  if (matchingKey.kind === 'user' || matchingKey.accessType !== 'all') {
    logger.warn(
      `Bearer auth denied for dashboard API: key id=${matchingKey.id}, name=${matchingKey.name} is not a system-level all-access key`,
    );
    return null;
  }

  logger.log(
    `Bearer auth succeeded with key id=${matchingKey.id}, name=${matchingKey.name}, accessType=${matchingKey.accessType}`,
  );
  return matchingKey;
};

const readonlyAllowPaths = ['/tools/'];

const checkReadonly = (req: Request): boolean => {
  if (!defaultConfig.readonly) {
    return true;
  }

  for (const path of readonlyAllowPaths) {
    if (req.path.startsWith(defaultConfig.basePath + path)) {
      return true;
    }
  }

  return req.method === 'GET';
};

const createSkipAuthUser = () => ({
  username: 'guest',
  isAdmin: true,
  credentialEligible: false,
});

const isDashboardApiRequest = (req: Request): boolean => {
  const basePath = defaultConfig.basePath || '';
  const apiPrefix = `${basePath}/api`;

  return (
    req.baseUrl === apiPrefix ||
    req.originalUrl === apiPrefix ||
    req.originalUrl.startsWith(`${apiPrefix}/`)
  );
};

// PUT/DELETE /credentials/:name is the only dashboard route a credential-write OAuth token opens.
const CREDENTIAL_WRITE_ROUTE = /^\/credentials\/([^/]+)\/?$/;

const matchCredentialWriteRoute = (req: Request): string | null => {
  if (req.method !== 'PUT' && req.method !== 'DELETE') return null;
  const match = CREDENTIAL_WRITE_ROUTE.exec(req.path);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

// Middleware to authenticate JWT token
export const auth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const t = (req as any).t;
  if (!checkReadonly(req)) {
    res.status(403).json({ success: false, message: t('api.errors.readonly') });
    return;
  }

  // Authentication policy must reflect updates made by other DB instances.
  const systemConfig = await getSystemConfigDao().get();
  const routingConfig = systemConfig?.routing || {
    enableGlobalRoute: true,
    enableGroupNameRoute: true,
    skipAuth: false,
  };

  // Header-only hardening: a credential in the URL is refused outright, even beside a valid header.
  const rejectedQueryParam = rejectsQueryCredential(req.query, systemConfig);
  if (rejectedQueryParam) {
    logger.warn(
      `Rejected a request carrying a credential in the URL query (${rejectedQueryParam})`,
    );
    res.status(401).json({ success: false, message: QUERY_CREDENTIAL_REJECTED_MESSAGE });
    return;
  }

  // A credential-write OAuth token is honoured on exactly one route and server, as its own user
  // and never as an administrator. Every other route, and every other credential, skips this
  // block, so such a token is not a bearer for anything else.
  const credentialWriteServer = matchCredentialWriteRoute(req);
  if (credentialWriteServer) {
    const presented = getBearerTokenFromHeaders(req.headers, systemConfig);
    const grant = presented ? await resolveCredentialWriteGrantFromToken(presented) : null;
    if (grant) {
      if (grant.serverName !== credentialWriteServer) {
        logger.warn(
          `Credential-write token for server=${grant.serverName} refused on another server (client=${grant.clientId})`,
        );
        res.status(403).json({
          success: false,
          message: 'This token cannot be used for that server',
        });
        return;
      }
      (req as any).user = {
        username: grant.username,
        isAdmin: false,
        credentialEligible: true,
        credentialWriteGrant: { clientId: grant.clientId, serverName: grant.serverName },
      };
      next();
      return;
    }
  }

  // Forward auth runs first: a JWT from the configured issuer either
  // authenticates here or is rejected, and never falls back to other methods.
  const forwardAuthResult = await authenticateForwardAuthToken(
    getBearerTokenFromHeaders(req.headers, systemConfig),
    systemConfig,
  );
  if (forwardAuthResult.status === 'rejected') {
    res.status(401).json({ success: false, message: 'Token is not valid' });
    return;
  }
  if (forwardAuthResult.status === 'authenticated') {
    (req as any).user = {
      username: forwardAuthResult.user.username,
      isAdmin: forwardAuthResult.user.isAdmin || false,
    };
    (req as any).forwardAuthUser = forwardAuthResult.user;
    next();
    return;
  }

  // Check if bearer auth via configured keys can validate this request
  let matchingBearerKey: BearerKey | null;
  try {
    matchingBearerKey = await validateBearerAuth(req, systemConfig);
  } catch (error) {
    next(error as Error);
    return;
  }

  if (matchingBearerKey) {
    (req as any).user = {
      username: matchingBearerKey.owner || 'system',
      isAdmin: true,
      credentialEligible: false,
    };
    (req as any).bearerKey = matchingBearerKey;
    next();
    return;
  }

  const betterAuthConfig = await getBetterAuthRuntimeConfig(systemConfig);
  if (betterAuthConfig.enabled) {
    const betterAuthUser = await resolveBetterAuthUserSafe(req);
    if (betterAuthUser) {
      (req as any).user = {
        username: betterAuthUser.username,
        isAdmin: betterAuthUser.isAdmin || false,
      };
      next();
      return;
    }
  }

  // Get token from header or query parameter
  const headerToken = req.header('x-auth-token');
  const queryToken = req.query.token as string;
  const token = headerToken || queryToken;

  if (!token && routingConfig.skipAuth && isDashboardApiRequest(req)) {
    (req as any).user = createSkipAuthUser();
    next();
    return;
  }

  // Check if no token
  if (!token) {
    res.status(401).json({ success: false, message: 'No token, authorization denied' });
    return;
  }

  // Verify JWT token
  try {
    const user = await resolveJwtUser(token);
    if (!user) {
      res.status(401).json({ success: false, message: 'Token is not valid' });
      return;
    }
    (req as any).user = { username: user.username, isAdmin: user.isAdmin || false };
    next();
  } catch (error) {
    res.status(401).json({ success: false, message: 'Token is not valid' });
  }
};
