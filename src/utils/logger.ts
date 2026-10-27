/**
 * Central logging utility with automatic secret redaction.
 *
 * All server-side logging should go through this module instead of the raw
 * `console` so that sensitive values (OAuth tokens, client secrets, API keys,
 * passwords, ...) never reach logs in clear text. Values are redacted by key
 * name for structured objects and by well-known token shapes for strings.
 */

import {
  REDACTED,
  redactArgs,
  redactEnv,
  redactHeaders,
  redactUrl,
  redactUrlsInText,
} from './redaction.js';

const JWT_REDACTED = '[REDACTED_JWT]';
const API_KEY_REDACTED = '[REDACTED_KEY]';

/** Maximum recursion depth when walking logged objects. */
const MAX_DEPTH = 6;

/** Maximum number of array entries rendered before truncating. */
const MAX_ARRAY_ENTRIES = 50;

/**
 * Key words that mark a property as sensitive. Matching is done on word
 * boundaries after splitting camelCase / snake_case / kebab-case keys, so
 * e.g. `accessToken`, `client_secret`, and `x-api-key` all match while
 * ordinary words like `author` or `keystone` do not.
 */
const SENSITIVE_KEY_WORDS = new Set([
  'password',
  'passwd',
  'pwd',
  'secret',
  'secrets',
  'token',
  'tokens',
  'credential',
  'credentials',
  'authorization',
  'cookie',
  'cookies',
  'apikey',
  'key',
  'privatekey',
  'accesskey',
]);

const splitKeyWords = (input: string): string[] =>
  input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export const isSensitiveKey = (key: string): boolean =>
  splitKeyWords(key).some((word) => SENSITIVE_KEY_WORDS.has(word));

/**
 * Mask well-known secret shapes inside free-form strings. Deliberately
 * conservative so human-readable operational messages pass through intact;
 * structured object logging is protected by key-based redaction instead.
 */
export const maskSecretPatterns = (value: string): string => {
  let result = value;
  // JWTs (header.payload.signature)
  result = result.replace(
    /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    JWT_REDACTED,
  );
  // Bearer credentials
  result = result.replace(/\b([Bb]earer)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]');
  // Secret-bearing URL query parameters
  result = result.replace(
    /\b(client_secret|access_token|refresh_token|id_token|api_key|apikey|authorization_code)=[^&\s"']+/g,
    '$1=[REDACTED]',
  );
  // `token=` and `key=` are credentials only inside a query string, so they need a ?/& anchor.
  result = result.replace(
    /([?&](?:token|key|auth_token|bearer_token|authorization|x-auth-token))=[^&\s"'#]+/gi,
    '$1=[REDACTED]',
  );
  // userinfo in a URL: scheme://user:pass@host
  result = result.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s"']+@/gi, '$1[REDACTED]@');
  // Any URL left in the text loses userinfo, query values and its fragment.
  result = redactUrlsInText(result);
  // Common API key prefixes (OpenAI/Anthropic style)
  result = result.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, API_KEY_REDACTED);
  // GitHub tokens
  result = result.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, API_KEY_REDACTED);
  result = result.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, API_KEY_REDACTED);
  return result;
};

type RedactionContext = {
  depth: number;
  seen: WeakSet<object>;
};

const redactValue = (value: unknown, ctx: RedactionContext): unknown => {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') {
      return maskSecretPatterns(value);
    }
    return value;
  }

  const { depth, seen } = ctx;
  if (depth >= MAX_DEPTH || seen.has(value)) {
    return '[Truncated]';
  }

  // Errors keep their class and stack so they render natively. When the message, the stack or
  // an attached property (an HTTP error's request config, say) carries something to redact, a
  // sanitized copy is logged instead; an error with nothing to redact is forwarded as is.
  if (value instanceof Error) {
    return redactError(value, ctx);
  }

  // Pass through exotic built-ins untouched (they rarely carry keyed secrets).
  if (value instanceof Date || value instanceof RegExp || Buffer.isBuffer(value)) {
    return value;
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items: unknown[] = value
        .slice(0, MAX_ARRAY_ENTRIES)
        .map((item) => redactValue(item, { depth: depth + 1, seen }));
      if (value.length > MAX_ARRAY_ENTRIES) {
        items.push(`... ${value.length - MAX_ARRAY_ENTRIES} more`);
      }
      return items;
    }

    if (value instanceof Map) {
      const entries: unknown[] = [];
      let count = 0;
      for (const [k, v] of value.entries()) {
        if (count >= MAX_ARRAY_ENTRIES) {
          entries.push('... more');
          break;
        }
        entries.push([
          redactValue(k, { depth: depth + 1, seen }),
          redactValue(v, { depth: depth + 1, seen }),
        ]);
        count += 1;
      }
      return entries;
    }

    if (value instanceof Set) {
      const items: unknown[] = [];
      let count = 0;
      for (const item of value.values()) {
        if (count >= MAX_ARRAY_ENTRIES) {
          items.push('... more');
          break;
        }
        items.push(redactValue(item, { depth: depth + 1, seen }));
        count += 1;
      }
      return items;
    }

    const plain = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(plain)) {
      output[key] =
        isSensitiveKey(key) && !isNonSensitiveValue(val)
          ? REDACTED
          : (redactStructured(key, val) ?? redactValue(val, { depth: depth + 1, seen }));
    }
    return output;
  } finally {
    seen.delete(value);
  }
};

const URL_KEY_RE = /(^|[_-])(url|uri|href|endpoint)$|(Url|Uri|Href|Endpoint)$/;
const HEADERS_KEY_RE = /^(headers|requestHeaders|responseHeaders|extraHeaders)$/i;
const ENV_KEY_RE = /^(env|environment|processEnv)$/i;
const ARGS_KEY_RE = /^(args|argv)$/i;

/**
 * Shapes whose content is credential-bearing whatever it is called: URLs lose userinfo and
 * query values, header maps lose credential headers, env maps lose every value, argument
 * lists lose credential flags. Returns undefined when the key says nothing special.
 */
const redactStructured = (key: string, value: unknown): unknown => {
  if (typeof value === 'string' && URL_KEY_RE.test(key) && /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return redactUrl(value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (HEADERS_KEY_RE.test(key)) return redactHeaders(value as Record<string, string>);
    if (ENV_KEY_RE.test(key)) return redactEnv(value as Record<string, unknown>);
  }
  if (Array.isArray(value) && ARGS_KEY_RE.test(key)) return redactArgs(value);
  return undefined;
};

/** Most own enumerable properties of an error that are walked; the rest are counted. */
const MAX_ERROR_PROPERTIES = 25;

/**
 * Class instances an error can carry (sockets, http requests and agents, streams, buffers) are
 * huge, cyclic and hold credentials in places no key name reveals: they are named, not walked.
 */
const summarizeNonPlain = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value) || value instanceof Error) return undefined;
  if (value instanceof Map || value instanceof Set || value instanceof Date) return undefined;
  if (value instanceof RegExp) return undefined;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) return undefined;
  return `[${(value as object).constructor?.name || 'Object'}]`;
};

// Never mutates the original: a change produces a copy that keeps the class and stack.
const redactError = (error: Error, ctx: RedactionContext): Error => {
  if (ctx.seen.has(error)) return new Error('[Circular]');
  if (ctx.depth >= MAX_DEPTH) return new Error('[Truncated]');
  ctx.seen.add(error);
  try {
    const next = { depth: ctx.depth + 1, seen: ctx.seen };
    const message = maskSecretPatterns(error.message);
    const stack = typeof error.stack === 'string' ? maskSecretPatterns(error.stack) : error.stack;
    const cause = (error as { cause?: unknown }).cause;
    const redactedCause = cause instanceof Error ? redactError(cause, next) : cause;
    const extras: Record<string, unknown> = {};
    let changed = message !== error.message || stack !== error.stack || redactedCause !== cause;
    const keys = Object.keys(error);
    for (const key of keys.slice(0, MAX_ERROR_PROPERTIES)) {
      const original = (error as unknown as Record<string, unknown>)[key];
      const summary = summarizeNonPlain(original);
      extras[key] =
        summary ??
        (isSensitiveKey(key) && !isNonSensitiveValue(original)
          ? REDACTED
          : (redactStructured(key, original) ?? redactValue(original, next)));
      if (extras[key] !== original) changed = true;
    }
    if (keys.length > MAX_ERROR_PROPERTIES) {
      extras['[truncated]'] = `${keys.length - MAX_ERROR_PROPERTIES} more properties`;
      changed = true;
    }
    if (!changed) return error;
    const copy = Object.create(Object.getPrototypeOf(error)) as Error;
    Object.defineProperty(copy, 'message', { value: message, configurable: true, writable: true });
    Object.defineProperty(copy, 'stack', { value: stack, configurable: true, writable: true });
    if (cause !== undefined) {
      Object.defineProperty(copy, 'cause', {
        value: redactedCause,
        configurable: true,
        writable: true,
      });
    }
    for (const [key, value] of Object.entries(extras)) {
      Object.defineProperty(copy, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } finally {
    ctx.seen.delete(error);
  }
};

/**
 * Allow obviously safe primitives under sensitive keys to survive redaction,
 * keeping useful context such as `{ authRequired: true }` readable.
 */
const isNonSensitiveValue = (value: unknown): boolean => {
  if (typeof value === 'boolean' || typeof value === 'number') {
    return true;
  }
  if (typeof value === 'string') {
    return /^(true|false|none|bearer|basic|\d+)$/.test(value.trim().toLowerCase());
  }
  return false;
};

/** Returns a deep copy of the input with secrets removed or masked. */
export const redact = <T>(value: T): T =>
  redactValue(value, { depth: 0, seen: new WeakSet() }) as T;

const emit = (level: 'log' | 'info' | 'warn' | 'error' | 'debug', args: unknown[]): void => {
  const sanitized = args.map((arg) => redact(arg));
  // Route back through console so existing tooling (and tests that spy on
  // console methods) keeps working unchanged.
  console[level](...sanitized);
};

export const logger = {
  log: (...args: unknown[]) => emit('log', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
  debug: (...args: unknown[]) => emit('debug', args),
};

export default logger;
