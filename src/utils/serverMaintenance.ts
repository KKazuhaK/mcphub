import type { ServerConfig, ServerMaintenance } from '../types/index.js';
import { logger } from './logger.js';
import { ServerConfigValidationError } from './serverConfigValidation.js';

export const MAX_PAUSED_USERS = 1000;
export const MAX_MAINTENANCE_MESSAGE_LENGTH = 200;
const MAX_USERNAME_LENGTH = 255;

// Control characters (including line breaks), Unicode format characters (bidi overrides,
// zero-width characters) and line or paragraph separators (U+2028, U+2029): the message is one visible line of plain text.
const UNSAFE_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// A full date-time with an explicit zone.
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

// True only for a real calendar instant: rejects 2026-02-30, hour 24 and out-of-range offsets.
const isRealDateTime = (value: string): boolean => {
  const match = ISO_DATE_TIME.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second = 0] = match
    .slice(1, 7)
    .map((part) => Number(part ?? 0));
  const [offsetHour = 0, offsetMinute = 0] = match.slice(7, 9).map((part) => Number(part ?? 0));
  if (offsetHour > 23 || offsetMinute > 59) return false;
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day &&
    check.getUTCHours() === hour &&
    check.getUTCMinutes() === minute &&
    check.getUTCSeconds() === second
  );
};

// `null` and `undefined` both mean "none" (a stored database row reads unset columns as null).
export const normalizePausedUsers = (value: unknown): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ServerConfigValidationError('pausedUsers must be an array of usernames');
  }
  const users = Array.from(
    new Set((value as string[]).map((item) => item.trim()).filter((item) => item.length > 0)),
  );
  if (users.some((user) => user.length > MAX_USERNAME_LENGTH)) {
    throw new ServerConfigValidationError(
      `pausedUsers entries must be at most ${MAX_USERNAME_LENGTH} characters`,
    );
  }
  if (users.length > MAX_PAUSED_USERS) {
    throw new ServerConfigValidationError(`pausedUsers can list at most ${MAX_PAUSED_USERS} users`);
  }
  return users.length > 0 ? users : undefined;
};

export const normalizeMaintenance = (value: unknown): ServerMaintenance | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ServerConfigValidationError('maintenance must be an object');
  }
  const { until, message } = value as { until?: unknown; message?: unknown };
  const normalized: ServerMaintenance = {};
  if (until !== undefined && until !== null && until !== '') {
    if (typeof until !== 'string' || !isRealDateTime(until.trim())) {
      throw new ServerConfigValidationError(
        'maintenance.until must be an ISO 8601 date-time with a time zone',
      );
    }
    normalized.until = new Date(until.trim()).toISOString();
  }
  if (message !== undefined && message !== null) {
    if (typeof message !== 'string') {
      throw new ServerConfigValidationError('maintenance.message must be a string');
    }
    const text = message.trim();
    if (text.length > MAX_MAINTENANCE_MESSAGE_LENGTH) {
      throw new ServerConfigValidationError(
        `maintenance.message must be at most ${MAX_MAINTENANCE_MESSAGE_LENGTH} characters`,
      );
    }
    if (UNSAFE_CHARACTERS.test(text)) {
      throw new ServerConfigValidationError('maintenance.message must be plain text');
    }
    if (text) normalized.message = text;
  }
  return normalized;
};

// Stored values are not re-validated on every edit. A malformed one is ignored, with one
// warning per distinct value, until an admin edit fixes or clears it.
const warnedInvalid = new Set<string>();
const warnInvalidStored = (field: string, value: unknown): void => {
  // Only a short, escaped excerpt reaches the log: the value is not trusted.
  const excerpt = (JSON.stringify(value) ?? String(value)).slice(0, 100);
  const key = `${field}:${excerpt}`;
  if (warnedInvalid.has(key) || warnedInvalid.size >= 100) return;
  warnedInvalid.add(key);
  logger.warn(`Ignoring invalid stored ${field}`, { excerpt });
};

// The maintenance window in force at `now`, or undefined. Computed at read time: an expired
// window needs no write to end.
export const getActiveMaintenance = (
  config: Pick<ServerConfig, 'maintenance'> | undefined,
  now: number = Date.now(),
): ServerMaintenance | undefined => {
  const maintenance = config?.maintenance as unknown;
  if (maintenance === undefined || maintenance === null) return undefined;
  const { until, message } = (
    maintenance && typeof maintenance === 'object' ? maintenance : {}
  ) as {
    until?: unknown;
    message?: unknown;
  };
  const valid =
    typeof maintenance === 'object' &&
    !Array.isArray(maintenance) &&
    (until === undefined || (typeof until === 'string' && !Number.isNaN(Date.parse(until)))) &&
    (message === undefined || typeof message === 'string');
  if (!valid) {
    warnInvalidStored('maintenance', maintenance);
    return undefined;
  }
  if (typeof until === 'string' && Date.parse(until) <= now) return undefined;
  // A stored message is sanitized on every read, whatever wrote it, before it can reach a
  // status text or a log.
  const text =
    typeof message === 'string'
      ? message
          .replace(new RegExp(UNSAFE_CHARACTERS.source, 'gu'), '')
          .trim()
          .slice(0, MAX_MAINTENANCE_MESSAGE_LENGTH)
          .replace(/[\uD800-\uDBFF]$/, '')
          .trim()
      : '';
  // Re-serialize the end time: Date.parse accepts free text in parentheses, which must not
  // be echoed into a status text or a log.
  return {
    ...(typeof until === 'string' ? { until: new Date(Date.parse(until)).toISOString() } : {}),
    ...(text ? { message: text } : {}),
  };
};

// A new end time must lie ahead, so a typo cannot silently create an already-over window.
// Saving the stored value back unchanged (a dashboard round trip) is not a new end time.
export const assertMaintenanceEndsInFuture = (
  next: ServerMaintenance | undefined,
  stored: ServerMaintenance | undefined,
  now: number = Date.now(),
): void => {
  if (!next?.until || next.until === stored?.until) return;
  if (Date.parse(next.until) <= now) {
    throw new ServerConfigValidationError('maintenance.until must be in the future');
  }
};

export const isPausedForUser = (
  config: Pick<ServerConfig, 'pausedUsers'> | undefined,
  username: string | undefined,
): boolean =>
  Boolean(username && Array.isArray(config?.pausedUsers) && config.pausedUsers.includes(username));

// Users whose paused state differs between two configurations.
export const diffPausedUsers = (before?: unknown, after?: unknown): string[] => {
  const previous = new Set(Array.isArray(before) ? before : []);
  const next = new Set(Array.isArray(after) ? after : []);
  return [...previous, ...next].filter((user) => previous.has(user) !== next.has(user));
};
