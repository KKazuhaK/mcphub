/**
 * Where the login page sends the browser back to after signing in from the OAuth consent flow.
 *
 * It is always the same authorize URL without any credential. The server serves the consent page
 * unauthenticated for a request that carries none, and the SPA signs its own requests with the
 * stored session (see OAuthConsentPage), so no token is ever put in a URL and no setting needs to
 * be consulted. A `token` parameter left over from an old link is dropped.
 */
export const buildOAuthReturnTarget = (
  returnUrl: string,
  origin: string = window.location.origin,
): string => {
  if (!returnUrl.startsWith('/oauth/authorize')) return returnUrl;
  try {
    const url = new URL(returnUrl, origin);
    url.searchParams.delete('token');
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return returnUrl;
  }
};
