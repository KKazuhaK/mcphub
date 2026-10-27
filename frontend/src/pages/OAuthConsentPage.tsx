import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ExternalLink } from 'lucide-react';
import { getBasePath } from '../utils/runtime';
import { getToken } from '../services/authService';
import ThemeSwitch from '@/components/ui/ThemeSwitch';
import LanguageSwitch from '@/components/ui/LanguageSwitch';
import type { OAuthConsentContext, ResourceTarget } from '../types/runtime';

/**
 * OAuth consent screen, booted inside the dashboard SPA by the shell the
 * backend serves at GET /oauth/authorize (context injected into
 * window.__OAUTH_CONSENT_CONTEXT__). The server has already validated the
 * request and resolved the user, so this page only renders the payload and
 * POSTs the decision back to /oauth/authorize.
 */
const OAuthConsentPage: React.FC = () => {
  const { t } = useTranslation();

  const context = useMemo<OAuthConsentContext | null>(
    () => window.__OAUTH_CONSENT_CONTEXT__ ?? null,
    [],
  );

  const postUrl = `${getBasePath()}/oauth/authorize`;
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Resolved by the server only after the session is established (needsSession mode).
  const [resolvedResource, setResolvedResource] = useState<ResourceTarget | undefined>();
  const [submitting, setSubmitting] = useState(false);

  // The server could not authenticate the navigation (credentials are never put in a URL), so
  // this page signs in with the session the dashboard already stores.
  const needsSession = context?.needsSession === true;

  const goToLogin = () => {
    const returnUrl = `${window.location.pathname}${window.location.search}`;
    window.location.assign(`${getBasePath()}/login?returnUrl=${encodeURIComponent(returnUrl)}`);
  };

  useEffect(() => {
    if (!needsSession) return;
    const token = getToken();
    if (!token) {
      goToLogin();
      return;
    }
    fetch(`${postUrl}${window.location.search}`, {
      headers: { Accept: 'application/json', 'x-auth-token': token },
    })
      .then(async (response) => {
        if (response.status === 401) return goToLogin();
        const body = (await response.json().catch(() => null)) as {
          resource?: ResourceTarget;
        } | null;
        if (body?.resource) setResolvedResource(body.resource);
      })
      .catch(() => undefined);
  }, [needsSession]);

  const submitDecision = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = getToken();
    if (!token) {
      goToLogin();
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body = new URLSearchParams();
      new FormData(event.currentTarget).forEach((value, key) => {
        if (typeof value === 'string') body.append(key, value);
      });
      const response = await fetch(postUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          'x-auth-token': token,
        },
        body,
      });
      if (response.status === 401) {
        goToLogin();
        return;
      }
      const result = (await response.json().catch(() => null)) as { redirect?: string } | null;
      if (result?.redirect) {
        window.location.assign(result.redirect);
        return;
      }
      setSubmitError(t('oauthServer.requestInvalid'));
    } catch {
      setSubmitError(t('oauthServer.requestInvalid'));
    } finally {
      setSubmitting(false);
    }
  };

  const hiddenInputs = (allow: string): React.ReactNode => {
    if (!context) return null;
    return (
      <>
        <input type="hidden" name="client_id" value={context.clientId} />
        <input type="hidden" name="redirect_uri" value={context.redirectUri} />
        <input type="hidden" name="response_type" value={context.responseType} />
        <input type="hidden" name="scope" value={context.scope} />
        {context.resource ? (
          <input type="hidden" name="resource" value={context.resource.raw} />
        ) : null}
        {context.state ? <input type="hidden" name="state" value={context.state} /> : null}
        {context.codeChallenge ? (
          <input type="hidden" name="code_challenge" value={context.codeChallenge} />
        ) : null}
        {context.codeChallengeMethod ? (
          <input type="hidden" name="code_challenge_method" value={context.codeChallengeMethod} />
        ) : null}
        {context.token ? <input type="hidden" name="token" value={context.token} /> : null}
        <input type="hidden" name="allow" value={allow} />
      </>
    );
  };

  // A credential-write request is shown as one sentence: no resource box, no scope rows.
  const credentialWrite = context?.credentialWrite;
  const shownResource = credentialWrite ? undefined : (resolvedResource ?? context?.resource);

  const resourceLabel = (resource: ResourceTarget): string => {
    switch (resource.kind) {
      case 'all':
        return t('oauthServer.resourceAll');
      case 'smart':
        return t('oauthServer.resourceSmart');
      case 'server':
        return t('oauthServer.resourceServer', { name: resource.name ?? '' });
      case 'group':
        return t('oauthServer.resourceGroup', { name: resource.name ?? '' });
      case 'external':
        // The administrator's name and the exact URL the token is for.
        return resource.name ? `${resource.name} (${resource.raw})` : resource.raw;
      default:
        return resource.name || resource.raw;
    }
  };

  const link = (href: string | undefined, label: string): React.ReactNode => {
    if (!href) return null;
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          fontSize: 11.5,
          color: 'var(--hub-ink-2)',
          textDecoration: 'none',
          borderBottom: '1px solid var(--hub-line)',
          paddingBottom: 1,
          maxWidth: 220,
        }}
        title={href}
      >
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
        <ExternalLink size={10} className="flex-shrink-0" />
      </a>
    );
  };

  if (!context) {
    return (
      <div
        className="relative min-h-screen w-full overflow-hidden"
        style={{ background: 'var(--hub-bg)', color: 'var(--hub-ink)' }}
      >
        <div className="relative mx-auto flex min-h-screen w-full max-w-lg items-center justify-center px-6">
          <div className="hub-card w-full" style={{ padding: '22px' }}>
            <div className="flex items-center gap-2" style={{ color: 'var(--hub-err)' }}>
              <AlertCircle size={16} className="flex-shrink-0" />
              <h1 className="hub-h1" style={{ fontSize: 15 }}>
                {t('oauthServer.requestInvalidTitle')}
              </h1>
            </div>
            <p className="hub-sub" style={{ marginTop: 8 }}>
              {t('oauthServer.requestInvalid')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const clientIdFingerprint = `${context.clientId.slice(0, 8)}…`;
  const client = context.client;
  const hasLinks = Boolean(client?.policyUri || client?.tosUri || client?.clientUri);

  return (
    <div
      className="relative min-h-screen w-full overflow-hidden"
      style={{ background: 'var(--hub-bg)', color: 'var(--hub-ink)' }}
    >
      {/* Top-right controls, matching the login screen */}
      <div className="absolute top-3 right-4 z-20 flex items-center gap-1">
        <ThemeSwitch />
        <LanguageSwitch />
      </div>

      <div className="relative mx-auto flex min-h-screen w-full max-w-lg items-center justify-center px-6">
        <div className="w-full space-y-6">
          {/* Brand */}
          <div className="flex flex-col items-center gap-3">
            <div
              className="relative grid place-items-center"
              style={{
                width: 44,
                height: 44,
                borderRadius: 10,
                background: 'var(--hub-ink)',
                color: 'var(--hub-bg)',
              }}
            >
              <span className="hub-mono font-semibold" style={{ fontSize: 18 }}>
                M
              </span>
            </div>
            <div className="text-center">
              <h1
                style={{
                  fontSize: 20,
                  fontWeight: 600,
                  letterSpacing: '-0.02em',
                  color: 'var(--hub-ink)',
                }}
              >
                {t('oauthServer.authorizeTitle')}
              </h1>
              <p className="hub-sub" style={{ marginTop: 4 }}>
                {t('oauthServer.authorizeSubtitle')}
              </p>
            </div>
          </div>

          {/* Consent card */}
          <div className="hub-card" style={{ padding: '22px 22px 20px' }}>
            {/* Resource target (RFC 8707) */}
            {shownResource ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '12px 14px',
                  borderRadius: 10,
                  background: 'var(--hub-accent-soft)',
                  border: '1px solid var(--hub-line)',
                  marginBottom: 14,
                }}
              >
                <span className="hub-sect">{t('oauthServer.grantingAccessTo')}</span>
                <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--hub-ink)' }}>
                  {resourceLabel(shownResource)}
                </span>
                <span
                  className="hub-mono"
                  style={{
                    fontSize: 11.5,
                    color: 'var(--hub-ink-2)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {shownResource.raw}
                </span>
              </div>
            ) : null}

            {/* Client box */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '12px 14px',
                borderRadius: 10,
                background: 'var(--hub-bg-2)',
                border: '1px solid var(--hub-line)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {client?.logoUri ? (
                  <img
                    src={client.logoUri}
                    alt=""
                    width={20}
                    height={20}
                    style={{ borderRadius: 4, flexShrink: 0, objectFit: 'contain' }}
                    referrerPolicy="no-referrer"
                  />
                ) : null}
                <span style={{ fontWeight: 600, fontSize: 15, color: 'var(--hub-ink)' }}>
                  {context.clientName}
                </span>
              </div>
              <span className="hub-sect">
                {t('oauthServer.clientId')}: <span className="hub-mono">{clientIdFingerprint}</span>
              </span>
              <span
                style={{
                  fontSize: 11.5,
                  color: 'var(--hub-ink-2)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={context.redirectUri}
              >
                {t('oauthServer.willRedirectTo')} {context.redirectUri}
              </span>
              {hasLinks ? (
                <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
                  {link(client?.policyUri, t('oauthServer.policy'))}
                  {link(client?.tosUri, t('oauthServer.terms'))}
                  {link(client?.clientUri, t('oauthServer.homepage'))}
                </div>
              ) : null}
            </div>

            {/* Scopes */}
            <div style={{ marginTop: 18 }}>
              {credentialWrite ? null : (
                <div className="hub-sect" style={{ marginBottom: 4 }}>
                  {t('oauthServer.scopesTitle')}
                </div>
              )}
              {credentialWrite ? (
                <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--hub-ink)', marginTop: 8 }}>
                  {t('oauthServer.credentialWrite', {
                    client: context.clientName,
                    server: credentialWrite.serverName,
                  })}
                </p>
              ) : context.scopes.length === 0 ? (
                <p className="hub-sub" style={{ marginTop: 8 }}>
                  {t('oauthServer.noScopes')}
                </p>
              ) : (
                <div className="hub-divider">
                  {context.scopes.map((scope) => (
                    <div key={scope.name} style={{ padding: '10px 0' }}>
                      <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--hub-ink)' }}>
                        <span className="hub-mono">{scope.name}</span>
                      </div>
                      <div style={{ fontSize: 12.5, color: 'var(--hub-ink-2)', marginTop: 2 }}>
                        {scope.description}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Approve / deny */}
            <div style={{ marginTop: 22, display: 'flex', gap: 10 }}>
              <form
                method="POST"
                action={postUrl}
                style={{ flex: 1 }}
                onSubmit={needsSession ? submitDecision : undefined}
              >
                {hiddenInputs('true')}
                <button
                  type="submit"
                  disabled={submitting}
                  className="hub-btn primary w-full justify-center"
                  style={{
                    height: 'auto',
                    minHeight: 40,
                    padding: '8px 12px',
                    flexDirection: 'column',
                    gap: 1,
                  }}
                >
                  <span style={{ lineHeight: 1.3 }}>{t('oauthServer.buttons.approve')}</span>
                </button>
              </form>
              <form
                method="POST"
                action={postUrl}
                style={{ flex: 1 }}
                onSubmit={needsSession ? submitDecision : undefined}
              >
                {hiddenInputs('false')}
                <button
                  type="submit"
                  className="hub-btn danger w-full justify-center"
                  style={{
                    height: 'auto',
                    minHeight: 40,
                    padding: '8px 12px',
                    flexDirection: 'column',
                    gap: 1,
                  }}
                >
                  <span style={{ lineHeight: 1.3 }}>{t('oauthServer.buttons.deny')}</span>
                </button>
              </form>
            </div>
            {submitError ? (
              <p
                className="hub-sub"
                role="alert"
                style={{ marginTop: 10, color: 'var(--hub-err)' }}
              >
                {submitError}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

export default OAuthConsentPage;
