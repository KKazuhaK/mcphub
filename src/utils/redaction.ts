/**
 * Central redaction helpers for anything that can reach a log line, an activity row or an
 * error message: URLs (userinfo, query strings, fragments), request headers, environment
 * variables, command-line arguments and upstream response bodies.
 *
 * The helpers are pure and have no imports so the logger itself can use them. Secrets that are
 * only known at runtime (a resolved credential slot, an OAuth token) are passed in explicitly.
 */

export const REDACTED = '[REDACTED]';

/**
 * A configured credential (a slot value, an OAuth or API security value) is scrubbed from text when
 * it is at least this long. Shorter values are NOT scrubbed: replacing a one- to three-character
 * string would mangle ordinary text, and a value that short is not a credential worth the damage.
 */
export const MIN_SECRET_LENGTH = 4;

/** Name-heuristic values (an env var called *_TOKEN) must be at least this long to count. */
export const MIN_HEURISTIC_SECRET_LENGTH = 8;

/**
 * For values that are only suspected of being secrets because of their name: booleans, numbers
 * and filesystem paths (`TOKEN_ENABLED=true`, `SESSION_DIR=/var/lib/x`) are configuration, and
 * scrubbing them would blank ordinary log text.
 */
export const looksLikeSecretValue = (value: string): boolean =>
  value.length >= MIN_HEURISTIC_SECRET_LENGTH &&
  !/^(?:true|false|yes|no|on|off|null|none)$/i.test(value) &&
  !/^-?\d+(?:\.\d+)?$/.test(value) &&
  !/^(?:\/|\.{1,2}\/|~\/|[A-Za-z]:[\\/])\S*$/.test(value);

/** Upstream bodies and messages are cut to this many characters before they are logged. */
export const MAX_LOGGED_BODY_LENGTH = 512;

const SENSITIVE_NAME_RE =
  /(authorization|cookie|token|secret|password|passwd|credential|api[-_]?key|apikey|private[-_]?key|access[-_]?key|signature|session|\bkey\b|[-_]key$|^key[-_])/i;

/** A header, env var or flag whose name says its value is a credential. */
export const isSensitiveName = (name: string): boolean => SENSITIVE_NAME_RE.test(name);

const unique = <T>(values: Iterable<T>): T[] => [...new Set(values)];

/** Every textual form a secret can take inside an error message or URL. */
const secretVariants = (secret: string): string[] => {
  const variants = [secret, JSON.stringify(secret).slice(1, -1)];
  const bare = secret.replace(/^(?:Bearer|Basic)\s+/i, '');
  if (bare !== secret) variants.push(bare);
  for (const value of [...variants]) {
    try {
      variants.push(encodeURIComponent(value));
    } catch {
      // A value can contain an unpaired surrogate; the literal forms still apply.
    }
  }
  return variants;
};

/** Longest first, so a secret that contains another is replaced whole. */
const normalizeSecrets = (secrets?: Iterable<string | undefined | null>): string[] =>
  secrets
    ? unique(
        [...secrets]
          .filter((value): value is string => typeof value === 'string')
          .flatMap(secretVariants),
      )
        .filter((value) => value.length >= MIN_SECRET_LENGTH)
        .sort((a, b) => b.length - a.length)
    : [];

/** Replace every literal occurrence of the given secrets. */
export const redactSecrets = (
  text: string,
  secrets?: Iterable<string | undefined | null>,
): string => {
  let result = text;
  for (const secret of normalizeSecrets(secrets)) result = result.split(secret).join(REDACTED);
  return result;
};

/**
 * Remove userinfo, the fragment and every query value from a URL, keeping the parameter names.
 * Works on text that is not a valid URL too (a request target such as `/mcp?token=abc`).
 */
export const redactUrl = (url: string, secrets?: Iterable<string | undefined | null>): string => {
  let result = url
    // https://user:pass@host -> https://[REDACTED]@host
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, `$1${REDACTED}@`)
    .replace(/#.*$/s, '');
  result = result.replace(/\?([^#\s]*)/, (_match, query: string) => {
    const redacted = query
      .split('&')
      .map((pair) => {
        const index = pair.indexOf('=');
        return index === -1 ? pair : `${pair.slice(0, index + 1)}${REDACTED}`;
      })
      .join('&');
    return `?${redacted}`;
  });
  return redactSecrets(result, secrets);
};

/** Redact every URL inside free text, for strings that embed a request target. */
export const redactUrlsInText = (
  text: string,
  secrets?: Iterable<string | undefined | null>,
): string =>
  redactSecrets(
    text.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi, (match) => redactUrl(match)),
    secrets,
  );

/** A request target for logging: the path with every query value removed. */
export const redactRequestUrl = (target: string | undefined): string =>
  target ? redactUrl(target) : '';

type HeaderValue = string | number | boolean | readonly string[] | undefined | null;

/**
 * Header values are removed when the header name is a credential, or when the value contains a
 * known secret. Names are kept so a log still says which headers were sent.
 */
export const redactHeaders = (
  headers: Record<string, HeaderValue> | undefined,
  secrets?: Iterable<string | undefined | null>,
): Record<string, string> => {
  const known = normalizeSecrets(secrets);
  const output: Record<string, string> = {};
  for (const [name, raw] of Object.entries(headers ?? {})) {
    const value = Array.isArray(raw) ? raw.join(', ') : raw == null ? '' : String(raw);
    output[name] =
      isSensitiveName(name) || known.some((secret) => value.includes(secret)) ? REDACTED : value;
  }
  return output;
};

/** Environment variables are never logged by value: only which names were set. */
export const redactEnv = (env: Record<string, unknown> | undefined): Record<string, string> =>
  Object.fromEntries(Object.keys(env ?? {}).map((name) => [name, REDACTED]));

/**
 * Command-line arguments: flags that name a credential lose their value (`--token=x`,
 * `--token x`), anything containing a known secret is replaced, URLs are reduced.
 */
export const redactArgs = (
  args: readonly unknown[] | undefined,
  secrets?: Iterable<string | undefined | null>,
): string[] => {
  const output: string[] = [];
  let maskNext = false;
  for (const raw of args ?? []) {
    const arg = String(raw);
    if (maskNext) {
      output.push(REDACTED);
      maskNext = false;
      continue;
    }
    const flag = /^(--?[A-Za-z0-9_.-]+)(=(.*))?$/s.exec(arg);
    if (flag && isSensitiveName(flag[1])) {
      if (flag[2] !== undefined) output.push(`${flag[1]}=${REDACTED}`);
      else {
        output.push(arg);
        maskNext = true;
      }
      continue;
    }
    output.push(redactUrlsInText(redactSecrets(arg, secrets), secrets));
  }
  return output;
};

/** A body or message from an upstream: secrets and credential shapes removed, then truncated. */
export const truncateBody = (
  body: string,
  max = MAX_LOGGED_BODY_LENGTH,
  secrets?: Iterable<string | undefined | null>,
): string => {
  const cleaned = redactUrlsInText(redactSecrets(body, secrets), secrets);
  return cleaned.length > max
    ? `${cleaned.slice(0, max)}...[truncated ${cleaned.length - max} chars]`
    : cleaned;
};
