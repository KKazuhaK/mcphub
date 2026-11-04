import { getBasePath as readBasePath } from './runtime';

const getBasePath = (): string => (typeof window === 'undefined' ? '' : readBasePath());

// The stable in-app link of a service's management page. The page behind it looks up the
// administrator's URL, so the link survives changes to it.
export const getServiceLinkPath = (name: string): string => `/services/${encodeURIComponent(name)}`;

// The same link as an href for a plain anchor, which the router's basename does not rewrite.
export const getServiceLinkHref = (name: string): string =>
  `${getBasePath()}${getServiceLinkPath(name)}`;

// Where the login page returns to after signing in from a protected /services link. Only these
// links are carried over; every other protected path keeps signing in to the home page.
export const getLoginRedirectPath = (pathname: string, search = ''): string => {
  if (!pathname.startsWith('/services/')) return '/login';
  return `/login?returnUrl=${encodeURIComponent(`${getBasePath()}${pathname}${search}`)}`;
};
