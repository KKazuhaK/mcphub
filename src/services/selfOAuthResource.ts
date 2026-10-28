import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Application } from 'express';
import type { ExternalResource, ServerConfig } from '../types/index.js';
import { getOAuthClientDao, getSystemConfigDao } from '../dao/index.js';
import { revokeUserClientResourceTokens } from '../models/OAuth.js';
import { cloneDefaultOAuthServerConfig } from '../constants/oauthServerDefaults.js';
import { findExternalResource, isClientAllowedForResource } from '../utils/externalResources.js';
import { buildRedirectUriFromBase } from '../utils/oauthRedirectUri.js';
import { resolveInstallBaseUrl } from '../utils/installBaseUrl.js';
import type { FetchLike } from '../utils/ssrf.js';
import { logger } from '../utils/logger.js';
import { CredentialBindingError } from '../utils/credentialTemplate.js';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

/**
 * An upstream MCP server that is itself an External Resource of this MCPHub (ADR 0014, ADR 0015):
 * its authorization server is MCPHub. Nothing here is needed unless the server declares personal
 * OAuth and its URL is exactly an `oauthServer.externalResources` entry.
 */

/** The one public OAuth client MCPHub uses for these connections. Listed in `allowedClients` to restrict. */
export const SELF_OAUTH_CLIENT_ID = 'mcphub-personal-oauth';
const SELF_OAUTH_CLIENT_NAME = 'MCPHub (personal connection)';

export interface SelfResource {
  /** MCPHub's issuer, exactly as in its authorization-server metadata (no trailing slash). */
  issuer: string;
  entry: ExternalResource;
}

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

/**
 * Whether `conf` is a personal-OAuth server whose URL is an external resource of this MCPHub and
 * whose authorization server is therefore MCPHub. Requires the public base URL (the only trustworthy
 * issuer, as for the tokens themselves) and an enabled authorization server. A server that pins
 * its own authorization endpoints is left alone.
 */
export const resolveSelfResource = async (
  conf: ServerConfig,
): Promise<SelfResource | undefined> => {
  const oauth = conf.oauth;
  if (
    oauth?.identityMode !== 'personal' ||
    !conf.url ||
    oauth.authorizationServerMetadata !== undefined ||
    oauth.authorizationEndpoint ||
    oauth.tokenEndpoint ||
    // An explicit client is the administrator's own configuration and keeps it. (The SDK stores
    // the public client's own id in the user's binding after the first authorization.)
    (oauth.clientId && oauth.clientId !== SELF_OAUTH_CLIENT_ID)
  ) {
    return undefined;
  }
  try {
    const systemConfig = await getSystemConfigDao().get();
    const entry = findExternalResource(systemConfig, conf.url);
    if (!entry) return undefined;
    const merged = { ...cloneDefaultOAuthServerConfig(), ...systemConfig?.oauthServer };
    if (merged.enabled === false) return undefined;
    const base = resolveInstallBaseUrl(systemConfig);
    if (!base) return undefined;
    return { issuer: stripTrailingSlashes(base), entry };
  } catch (error) {
    logger.warn('Could not determine whether a server is an external resource of this hub', error);
    return undefined;
  }
};

const RESERVED_CLIENT_MESSAGE = `oauth.clientId '${SELF_OAUTH_CLIENT_ID}' is reserved for MCPHub's own connection to a server whose url is an external resource of this MCPHub (oauthServer.externalResources, with the public base URL set). Remove it, or use your own client.`;

/**
 * Refuse, at save time, a server that names the public client without being a self-resource server,
 * which would borrow its first-party consent name. Throws a CredentialBindingError (a 400).
 */
export const assertSelfClientIdAllowed = async (config: ServerConfig): Promise<void> => {
  if (config.oauth?.clientId !== SELF_OAUTH_CLIENT_ID) return;
  if (!(await resolveSelfResource(config)))
    throw new CredentialBindingError(RESERVED_CLIENT_MESSAGE);
};

/** Same rule at connect time, for a definition that predates it or an entry that has since gone. */
export const assertSelfClientIdInUse = async (
  serverName: string,
  config: ServerConfig,
  self: SelfResource | undefined,
): Promise<void> => {
  if (config.oauth?.clientId === SELF_OAUTH_CLIENT_ID && !self) {
    throw new CredentialBindingError(`'${serverName}': ${RESERVED_CLIENT_MESSAGE}`);
  }
};

/** The client's one redirect URI: derived from the configured public URL, never from a server config. */
export const selfRedirectUri = (issuer: string): string => {
  const uri = buildRedirectUriFromBase(issuer);
  if (!uri) throw new Error('The public base URL is not a valid URL');
  return uri;
};

export const isProtectedSelfClient = (clientId: string): boolean =>
  clientId === SELF_OAUTH_CLIENT_ID;

const sameList = (a: string[] | undefined, b: string[]): boolean =>
  Array.isArray(a) && a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Create or heal the public client. Idempotent, and run whenever a self-resource server connects, so
 * whatever the stored record has become (an edit, an import, a database row) it is public, has the
 * two grants it needs and exactly one redirect URI: MCPHub's own OAuth callback, taken from the
 * public base URL. Nothing a server declares (`oauth.redirectUri`, registration metadata) can add
 * to that list, so a code issued to this client can only be delivered to this hub.
 */
export const ensureSelfOAuthClient = async (issuer: string): Promise<void> => {
  const dao = getOAuthClientDao();
  const redirectUris = [selfRedirectUri(issuer)];
  const grants = ['authorization_code', 'refresh_token'];
  const existing = await dao.findByClientId(SELF_OAUTH_CLIENT_ID);
  if (!existing) {
    await dao.create({
      clientId: SELF_OAUTH_CLIENT_ID,
      name: SELF_OAUTH_CLIENT_NAME,
      redirectUris,
      grants,
      owner: 'admin',
      metadata: { application_type: 'web', token_endpoint_auth_method: 'none' },
    });
    return;
  }
  if (
    existing.name !== SELF_OAUTH_CLIENT_NAME ||
    !sameList(existing.redirectUris, redirectUris) ||
    !sameList(existing.grants, grants) ||
    existing.clientSecret ||
    existing.scopes?.length
  ) {
    // Explicit null: a database merge skips undefined and would keep a secret.
    await dao.update(SELF_OAUTH_CLIENT_ID, {
      name: SELF_OAUTH_CLIENT_NAME,
      redirectUris,
      grants,
      clientSecret: null,
      scopes: [],
    });
  }
};

/**
 * An administrator-facing reason this server cannot connect, or undefined. The entry may restrict
 * which clients can request the resource; the self client must then be listed.
 */
export const selfResourceRefusal = (serverName: string, self: SelfResource): string | undefined =>
  isClientAllowedForResource(self.entry, SELF_OAUTH_CLIENT_ID)
    ? undefined
    : `'${serverName}' is an external resource of this MCPHub, but its allowedClients list does not include '${SELF_OAUTH_CLIENT_ID}'. Add it to oauthServer.externalResources for ${self.entry.resource}.`;

/**
 * End every grant of the public client for `username` and these resources on this hub's own
 * authorization server (all of its access and refresh records, so a rotation in flight or a
 * different spelling of the resource cannot leave one behind). The upstream has no revocation
 * endpoint to call (MCPHub publishes none), so disconnecting or reconnecting would otherwise leave a
 * live refresh token behind. A JWT already issued stays valid until it expires, at most
 * `externalTokenLifetimeSeconds`.
 */
export const revokeSelfGrants = async (
  username: string,
  resources: Array<string | undefined>,
): Promise<void> => {
  for (const resource of new Set(resources.filter((r): r is string => Boolean(r)))) {
    await revokeUserClientResourceTokens(username, SELF_OAUTH_CLIENT_ID, resource);
  }
};

// ---------------------------------------------------------------------------
// In-process dispatch
// ---------------------------------------------------------------------------

// MCPHub's own metadata and token endpoint are reached through a small dedicated app on a listener
// bound to 127.0.0.1 (ephemeral port) that serves exactly those two routes, with its own rate limit,
// never through the public URL. Behind a proxy the public URL may be unreachable from the server
// itself (hairpin NAT, split DNS), may resolve to an address the SSRF guard refuses, and would send
// the user's own tokens across the network for no reason.
let selfServer: http.Server | undefined;
let selfOrigin: Promise<string> | undefined;

export const closeSelfOAuthDispatch = (): void => {
  selfServer?.close();
  selfServer?.closeAllConnections?.();
  selfServer = undefined;
  selfOrigin = undefined;
};

/** Header the in-process fetch sets so the limiter can tell whose request it is (loopback only). */
const SELF_KEY_HEADER = 'x-mcphub-self-key';

export const buildSelfApp = async (
  limits: { perKey?: number; ceiling?: number } = {},
): Promise<Application> => {
  // Loaded on first use: the controller pulls in most of the application.
  const { getMetadata, postToken } = await import('../controllers/oauthServerController.js');
  const limiter = (max: number, keyGenerator: (req: express.Request) => string) =>
    rateLimit({
      windowMs: 60_000,
      limit: max,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator,
      message: { error: 'too_many_requests' },
    });
  const header = (req: express.Request): string => {
    const value = req.headers[SELF_KEY_HEADER];
    return typeof value === 'string' && value ? value : ipKeyGenerator(req.ip ?? '');
  };
  // Own budgets, shared with no public traffic: one per user and server, so a burst by one user
  // cannot starve another's refresh, and a generous ceiling over all of them as a backstop.
  const perKey = limiter(limits.perKey ?? 120, header);
  const ceiling = limiter(limits.ceiling ?? 1200, () => 'all');
  const app = express();
  app.disable('x-powered-by');
  app.get('/.well-known/oauth-authorization-server', ceiling, perKey, getMetadata);
  app.post('/oauth/token', express.urlencoded({ extended: true }), ceiling, perKey, postToken);
  return app;
};

const loopbackOrigin = (): Promise<string> => {
  if (!selfOrigin) {
    const origin = (async () => {
      const server = http.createServer(await buildSelfApp());
      selfServer = server;
      return new Promise<string>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.unref();
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        });
      });
    })();
    selfOrigin = origin;
    origin.catch(() => {
      if (selfOrigin === origin) {
        selfServer = undefined;
        selfOrigin = undefined;
      }
    });
  }
  return selfOrigin;
};

/** The two endpoints the OAuth client needs from its own authorization server. */
const localPathFor = (issuer: URL, requested: URL): string | undefined => {
  if (requested.origin !== issuer.origin) return undefined;
  const prefix = stripTrailingSlashes(issuer.pathname);
  const path = requested.pathname;
  const metadata = '/.well-known/oauth-authorization-server';
  if (path === metadata || path === `${metadata}${prefix}` || path === `${prefix}${metadata}`) {
    return metadata;
  }
  if (path === `${prefix}/oauth/token`) return '/oauth/token';
  return undefined;
};

/**
 * A fetch that serves requests for MCPHub's own authorization-server metadata and token endpoint
 * in-process and passes everything else (the upstream resource, and its protected-resource
 * metadata) to `next`.
 */
export const createSelfIssuerFetch = (
  issuer: string,
  next: FetchLike,
  limiterKey?: string,
): FetchLike => {
  const issuerUrl = new URL(issuer);
  return async (input, init) => {
    let requested: URL;
    try {
      requested = new URL(typeof input === 'string' ? input : input.toString());
    } catch {
      return next(input, init);
    }
    const localPath = localPathFor(issuerUrl, requested);
    if (!localPath) return next(input, init);
    const origin = await loopbackOrigin();
    // The issuer comes from the configured public URL, not the Host header, so the answer is the
    // same as over the public URL.
    const headers = new Headers(init?.headers);
    // Hashed: a username may hold characters a header cannot.
    if (limiterKey)
      headers.set(SELF_KEY_HEADER, createHash('sha256').update(limiterKey).digest('hex'));
    return fetch(`${origin}${localPath}${requested.search}`, {
      ...init,
      headers,
      redirect: 'manual',
    });
  };
};
