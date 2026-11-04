import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { apiGet, type ApiResponse } from '../utils/fetchInterceptor';
import { getSafeManageHref } from '../utils/manageUrl';

type State = 'loading' | 'missing';

// Sends the user on to a service's own account or token page.
export default function ServiceLinkPage() {
  const { t } = useTranslation();
  const { serverName = '' } = useParams<{ serverName: string }>();
  const [state, setState] = useState<State>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    apiGet<ApiResponse<{ manageUrl: string | null }>>(
      `/services/${encodeURIComponent(serverName)}/manage-url`,
    )
      .then((result) => {
        if (cancelled) return;
        const href = result.success ? getSafeManageHref(result.data?.manageUrl) : undefined;
        if (href) window.location.replace(href);
        else setState('missing');
      })
      .catch(() => {
        if (!cancelled) setState('missing');
      });
    return () => {
      cancelled = true;
    };
  }, [serverName]);

  if (state === 'loading') {
    return (
      <div className="hub-card p-10 text-center text-sm" style={{ color: 'var(--hub-ink-3)' }}>
        {t('serviceLink.redirecting')}
      </div>
    );
  }
  return (
    <div className="hub-card mx-auto max-w-xl p-10 text-center text-sm" role="status">
      <p style={{ color: 'var(--hub-ink-2)' }}>{t('serviceLink.noManagePage')}</p>
      <Link to="/workspace" className="mt-3 inline-block underline">
        {t('serviceLink.backToWorkspace')}
      </Link>
    </div>
  );
}
