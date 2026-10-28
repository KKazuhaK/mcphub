import type { ExternalResource, SystemConfig } from '../types/index.js';
import { parseResourceTarget } from './oauthConsentResource.js';

/**
 * External protected resources MCPHub's authorization server may issue JWT access tokens for
 * (RFC 8707 `resource`). See docs/adr/0014-external-resource-tokens.md.
 */

export const MAX_EXTERNAL_RESOURCES = 50;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 100;
const MAX_ALLOWED_CLIENTS = 100;
const MAX_CLIENT_ID_LENGTH = 2048;

export class ExternalResourceValidationError extends Error {}

const isLoopbackHost = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

/** Absolute https URL, or http on a loopback host; no fragment and no credentials. */
export const isValidExternalResourceUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || value.includes('#') || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
};

/**
 * Validate the administrator's `externalResources` value. Throws
 * ExternalResourceValidationError with a message safe to return to the administrator.
 */
export const normalizeExternalResources = (value: unknown): ExternalResource[] => {
  if (!Array.isArray(value)) {
    throw new ExternalResourceValidationError('externalResources must be an array');
  }
  if (value.length > MAX_EXTERNAL_RESOURCES) {
    throw new ExternalResourceValidationError(
      `externalResources can list at most ${MAX_EXTERNAL_RESOURCES} resources`,
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const where = `externalResources[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ExternalResourceValidationError(`${where} must be an object`);
    }
    const { resource, name, allowedClients } = entry as Record<string, unknown>;
    if (!isValidExternalResourceUrl(resource)) {
      throw new ExternalResourceValidationError(
        `${where}.resource must be an absolute https URL (http only for localhost, 127.0.0.1 or [::1]) without credentials or a fragment`,
      );
    }
    if (seen.has(resource)) {
      throw new ExternalResourceValidationError(`${where}.resource is listed twice`);
    }
    seen.add(resource);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_NAME_LENGTH) {
      throw new ExternalResourceValidationError(
        `${where}.name must be a non-empty string of at most ${MAX_NAME_LENGTH} characters`,
      );
    }
    const normalized: ExternalResource = { resource, name: name.trim() };
    if (allowedClients !== undefined && allowedClients !== null) {
      if (
        !Array.isArray(allowedClients) ||
        allowedClients.length > MAX_ALLOWED_CLIENTS ||
        allowedClients.some(
          (client) => typeof client !== 'string' || !client || client.length > MAX_CLIENT_ID_LENGTH,
        )
      ) {
        throw new ExternalResourceValidationError(
          `${where}.allowedClients must be an array of OAuth client ids`,
        );
      }
      normalized.allowedClients = Array.from(new Set(allowedClients as string[]));
    }
    return normalized;
  });
};

export const getExternalResources = (
  systemConfig?: Pick<SystemConfig, 'oauthServer'> | null,
): ExternalResource[] => {
  const list = systemConfig?.oauthServer?.externalResources;
  return Array.isArray(list) ? list : [];
};

/** The entry whose `resource` equals `resource` exactly (no normalisation of either side). */
export const findExternalResource = (
  systemConfig: Pick<SystemConfig, 'oauthServer'> | null | undefined,
  resource: string,
): ExternalResource | undefined =>
  getExternalResources(systemConfig).find((entry) => entry.resource === resource);

/** Empty or absent `allowedClients` means any registered client. */
export const isClientAllowedForResource = (entry: ExternalResource, clientId: string): boolean =>
  !entry.allowedClients || entry.allowedClients.length === 0
    ? true
    : entry.allowedClients.includes(clientId);

export type ResourceClassification =
  | { kind: 'none' }
  // One of MCPHub's own routes: handled exactly as before this feature existed.
  | { kind: 'own' }
  | { kind: 'external'; entry: ExternalResource }
  | { kind: 'invalid'; reason: string };

const originOf = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

/** Where MCPHub's own routes live, as far as this install can tell. */
export interface OwnResourceScope {
  /** The issuer and the host the request arrived on. */
  origins: Array<string | undefined>;
  /**
   * True when the public URL is configured (`install.baseUrl` or INSTALL_BASE_URL), so the origins
   * above are trustworthy. Otherwise MCPHub may be reached through a proxy that rewrites the host,
   * and a resource shaped like one of its MCP routes counts as its own whatever the origin, which
   * is what every such deployment relied on before external resources existed.
   */
  strict: boolean;
}

/**
 * Decide what a requested `resource` is. Exactly one string is accepted. An exact match of a
 * configured external resource (for an allowed client) is external; a URL on MCPHub's own origin
 * is one of its MCP routes; anything else is invalid_target (RFC 8707 section 2).
 * A client that is not allowed gets the same answer as an unknown resource, so a response never
 * reveals which resources are configured.
 */
export const classifyResource = (
  raw: unknown,
  systemConfig: Pick<SystemConfig, 'oauthServer'> | null | undefined,
  own: OwnResourceScope,
  // Given at the authorization endpoint, where the client is known; the token endpoint checks
  // the authenticated client when it issues the token.
  clientId?: string,
): ResourceClassification => {
  if (raw === undefined || raw === null || raw === '') return { kind: 'none' };
  if (typeof raw !== 'string') {
    return { kind: 'invalid', reason: 'Exactly one resource is supported' };
  }
  const entry = findExternalResource(systemConfig, raw);
  if (entry) {
    return clientId === undefined || isClientAllowedForResource(entry, clientId)
      ? { kind: 'external', entry }
      : { kind: 'invalid', reason: 'The requested resource is not available' };
  }
  const origin = originOf(raw);
  if (origin && own.origins.some((candidate) => candidate && originOf(candidate) === origin)) {
    return { kind: 'own' };
  }
  if (!own.strict && origin && ['all', 'smart', 'target'].includes(parseResourceTarget(raw).kind)) {
    return { kind: 'own' };
  }
  return { kind: 'invalid', reason: 'The requested resource is not available' };
};
