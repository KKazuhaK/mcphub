export const MANAGE_URL_MAX_LENGTH = 2048;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export type ManageUrlProblem = 'tooLong' | 'invalid' | 'scheme' | 'credentials';

// Mirrors the backend rule: an absolute https: URL, or http: for a loopback host, without
// embedded credentials. Returns the problem, or null when the URL is acceptable.
export const getManageUrlProblem = (value: string): ManageUrlProblem | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MANAGE_URL_MAX_LENGTH) return 'tooLong';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'invalid';
  }
  const isLoopback = LOOPBACK_HOSTS.has(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
    return 'scheme';
  }
  if (parsed.username || parsed.password) return 'credentials';
  return null;
};

// The problem to report when the form is submitted. Only administrators edit the field, so
// nothing is checked for anyone else.
export const getManageUrlSubmitProblem = (
  value: string | undefined,
  isAdmin: boolean,
): ManageUrlProblem | null => (isAdmin ? getManageUrlProblem(value || '') : null);

// The value to use as an href, or undefined when it is unset or not a safe web link.
export const getSafeManageHref = (value?: string | null): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || getManageUrlProblem(trimmed)) return undefined;
  return trimmed;
};
