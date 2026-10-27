import { personalOAuthContexts } from '../services/personalOAuthService.js';
import type { OpenAPISecurityConfig, ServerConfig } from '../types/index.js';
import { argumentCredentialBindings, resolvedCredentialValues } from './credentialTemplate.js';
import {
  isSensitiveName,
  looksLikeSecretValue,
  MIN_SECRET_LENGTH,
  redactSecrets,
} from './redaction.js';
import {
  formatErrorForLogging,
  sanitizeStringForLogging,
  summarizeErrorForLogging,
} from './serialization.js';

/** A safe diagnostic that can cross both the logging and client-response boundaries. */
export class UpstreamRequestError extends Error {
  // True when the upstream's transport answered HTTP 401 or an invalid_token challenge,
  // i.e. it refused the credential itself rather than failing for another reason.
  authRejected = false;

  constructor(message: string) {
    super(message);
    this.name = 'UpstreamRequestError';
  }
}

const securityValues = (security: OpenAPISecurityConfig | undefined): (string | undefined)[] => {
  if (!security) return [];
  const credentials = security.http?.credentials;
  let decoded: string[] = [];
  if (credentials) {
    // Basic credentials are base64 of `user:password`; the parts can appear on their own.
    try {
      const text = Buffer.from(credentials, 'base64').toString('utf8');
      if (text.includes(':')) decoded = [text, ...text.split(':')];
    } catch {
      // Not base64: the literal value still applies.
    }
  }
  return [
    security.apiKey?.value,
    credentials,
    ...decoded,
    security.oauth2?.token,
    security.oauth2?.clientSecret,
    security.openIdConnect?.token,
    security.openIdConnect?.clientSecret,
  ];
};

/**
 * Every value in a server runtime config that must not appear in a log line or error message.
 *
 * Definite credentials, scrubbed from length 4: resolved credential slots (url, header, env and
 * args), OAuth tokens and secrets, and OpenAPI security values (API key, HTTP credentials,
 * OAuth2 and OpenID Connect tokens and client secrets). Personal values can be opaque strings
 * with no recognizable token shape, so they are matched literally.
 *
 * Suspected credentials, by name only: env and header entries whose name says "token", "key",
 * "secret" and so on. They count only when they look like a secret (length 8 or more, not a
 * boolean, number or filesystem path), so `TOKEN_ENABLED=true` or `SESSION_DIR=/tmp/x` do not
 * blank ordinary text.
 */
export const collectConfigSecrets = (config: ServerConfig): string[] => {
  const oauth = personalOAuthContexts.get(config)?.config.oauth || config.oauth;
  const suspected = [config.env, config.headers].flatMap((record) =>
    Object.entries(record ?? {})
      .filter(([name, value]) => isSensitiveName(name) && typeof value === 'string')
      .map(([, value]) => value)
      .filter(looksLikeSecretValue),
  );
  return [
    ...(resolvedCredentialValues.get(config) ?? []),
    ...(config.credentialTemplate ?? []).map((slot) =>
      slot.target === 'args'
        ? argumentCredentialBindings.get(config)?.[slot.name]
        : slot.target === 'url'
          ? config.url
          : config[slot.target]?.[slot.name],
    ),
    oauth?.accessToken,
    oauth?.refreshToken,
    oauth?.clientSecret,
    oauth?.pendingAuthorization?.codeVerifier,
    ...securityValues(config.openapi?.security),
    ...securityValues(config.openapi?.specSecurity),
    ...suspected,
  ].filter(
    (value): value is string => typeof value === 'string' && value.length >= MIN_SECRET_LENGTH,
  );
};

export const createUpstreamRequestError = (
  server: string,
  operation: string,
  error: unknown,
  config: ServerConfig,
): UpstreamRequestError => {
  const secrets = collectConfigSecrets(config);
  const redact = (value: string): string =>
    sanitizeStringForLogging(redactSecrets(value, secrets)).slice(0, 2048);
  // Never attach the original cause/config/body/stack to the safe error.
  const record =
    error && typeof error === 'object'
      ? (error as {
          message?: unknown;
          name?: unknown;
          code?: unknown;
          status?: unknown;
          response?: { status?: unknown; headers?: Record<string, unknown> };
        })
      : undefined;
  const requestId =
    record?.response?.headers?.['x-request-id'] ??
    record?.response?.headers?.['request-id'] ??
    record?.response?.headers?.['x-ms-request-id'] ??
    record?.response?.headers?.['x-correlation-id'];
  const summary = summarizeErrorForLogging({
    name: typeof record?.name === 'string' ? redact(record.name) : 'Error',
    message: redact(
      typeof record?.message === 'string'
        ? record.message
        : typeof error === 'string'
          ? error
          : 'Upstream request failed',
    ),
    code: typeof record?.code === 'string' ? redact(record.code) : record?.code,
    status: record?.status ?? record?.response?.status,
    requestId: typeof requestId === 'string' ? redact(requestId) : undefined,
  });
  const failure = new UpstreamRequestError(
    `Upstream '${redact(server)}' ${operation} failed: ${formatErrorForLogging(summary)}`,
  );
  const status = record?.status ?? record?.response?.status ?? record?.code;
  const challenge = record?.response?.headers?.['www-authenticate'];
  failure.authRejected =
    status === 401 || (typeof challenge === 'string' && /invalid_token/i.test(challenge));
  return failure;
};

export const isUpstreamConnectionFailure = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === 'string' && ['ECONNRESET', 'EPIPE', 'ENOTCONN', 'ECONNREFUSED'].includes(code)
  );
};
