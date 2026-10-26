import axios from 'axios';
import { Agent } from 'node:https';
import { assertSafeUrl, createSafeLookup } from '../utils/ssrf.js';
import type { CanvasReminder } from './canvasCredentialMetadata.js';

/** Only operator-approved HTTPS origins receive credentials; redirects are never followed. */
export const canvasApiBase = (value: string): string => {
  const url = new URL(value.trim());
  const allowed = (process.env.MCPHUB_CANVAS_ORIGINS || '').split(',').map((s) => s.trim());
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !allowed.includes(url.origin) ||
    !['', '/', '/api/v1', '/api/v1/'].includes(url.pathname)
  ) {
    throw new Error('Canvas origin is not approved for expiration checks');
  }
  return `${url.origin}/api/v1`;
};
const publicAgent = new Agent({ lookup: createSafeLookup(undefined, []) });
const getJson = async (url: string, token: string): Promise<Record<string, unknown>> => {
  await assertSafeUrl(url, { allowedCidrs: [] });
  const response = await axios.get(url, {
    httpsAgent: publicAgent,
    proxy: false,
    timeout: 5000,
    maxRedirects: 0,
    maxContentLength: 16384,
    responseType: 'json',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!response.data || typeof response.data !== 'object' || Array.isArray(response.data)) {
    throw new Error('Invalid Canvas metadata');
  }
  return response.data;
};
export const discoverCanvasExpiry = async (
  values: Record<string, string>,
): Promise<Pick<CanvasReminder, 'source' | 'expiresAt'>> => {
  try {
    const base = canvasApiBase(values['env.CANVAS_API_URL']);
    const token = values['env.CANVAS_API_TOKEN'];
    const raw = token.split('~').pop() || '';
    if (raw.length < 20 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('Invalid token format');
    const profile = await getJson(`${base}/users/self/profile`, token);
    if (!['string', 'number'].includes(typeof profile.id)) throw new Error('Missing identity');
    const hint = raw.slice(0, 5);
    const data = await getJson(`${base}/users/self/tokens/${hint}`, token);
    const matches: boolean[] = [];
    if ('token_hint' in data) matches.push(data.token_hint === hint);
    if (data.visible_token != null)
      matches.push(
        [hint + '...', token.slice(0, token.length - raw.length) + hint + '...'].includes(
          String(data.visible_token),
        ),
      );
    if (
      String(data.user_id) !== String(profile.id) ||
      !matches.length ||
      matches.some((m) => !m) ||
      !('expires_at' in data)
    )
      throw new Error('Unproven token metadata');
    if (data.expires_at === null) return { source: 'canvas', expiresAt: null };
    if (
      typeof data.expires_at !== 'string' ||
      data.expires_at.length > 64 ||
      !/(Z|[+-]\d\d:\d\d)$/.test(data.expires_at)
    )
      throw new Error('Invalid expiry');
    const expiry = Date.parse(data.expires_at);
    if (!Number.isFinite(expiry) || expiry <= 0 || expiry > Date.parse('2100-01-01T00:00:00Z'))
      throw new Error('Invalid expiry');
    return { source: 'canvas', expiresAt: new Date(expiry).toISOString() };
  } catch {
    // Axios errors include credentials in request config. Never log or return them.
    return { source: 'unknown', expiresAt: null };
  }
};
