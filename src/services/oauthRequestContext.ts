import { AsyncLocalStorage } from 'node:async_hooks';
import type { ResourceClassification } from '../utils/externalResources.js';

/**
 * Per-request facts the OAuth library does not carry to the token model: this install's issuer and
 * the external resource (RFC 8707) the request named, classified by the controller. `resource` is
 * the validated external resource an authorization request binds its code to; `requested` is what
 * a token request named. See docs/adr/0014-external-resource-tokens.md.
 */
export interface OAuthRequestContext {
  issuer?: string;
  resource?: string;
  requested?: ResourceClassification;
  grantType?: string;
}

export const oauthRequestContext = new AsyncLocalStorage<OAuthRequestContext>();

export const runWithOAuthRequestContext = <T>(
  context: OAuthRequestContext,
  run: () => Promise<T>,
): Promise<T> => oauthRequestContext.run(context, run);
