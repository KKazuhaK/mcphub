import { ServerConfigValidationError } from './serverConfigValidation.js';

export const MANAGE_URL_MAX_LENGTH = 2048;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Returns the normalized management page URL, or undefined for an unset or
 * whitespace-only value. Only absolute https: URLs are accepted, plus http:
 * for a loopback host; credentials in the URL are rejected.
 */
export const normalizeManageUrl = (value: unknown): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ServerConfigValidationError('manageUrl must be a string');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > MANAGE_URL_MAX_LENGTH) {
    throw new ServerConfigValidationError(
      `manageUrl must be at most ${MANAGE_URL_MAX_LENGTH} characters`,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ServerConfigValidationError('manageUrl must be an absolute URL');
  }

  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    throw new ServerConfigValidationError(
      'manageUrl must use https (http is allowed only for localhost)',
    );
  }
  if (parsed.username || parsed.password) {
    throw new ServerConfigValidationError('manageUrl must not contain credentials');
  }

  return trimmed;
};
