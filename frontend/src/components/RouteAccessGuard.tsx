import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/contexts/AuthContext';
import { useSettings } from '@/contexts/SettingsContext';
import { fallbackPath, isRouteAllowed } from '@/utils/navigationPermissions';

/**
 * Keeps ordinary users on the pages meant for them while Workspace Mode is on, and hides the
 * workspace pages while it is off. Everything is allowed when the mode is off.
 */
const RouteAccessGuard: React.FC = () => {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const { workspaceEnabled, workspaceResolved, workspaceLoadFailed, fetchSettings } = useSettings();
  const { pathname } = useLocation();

  // Wait for the setting so an ordinary user never flashes an admin page. A failed read
  // resolves it too (with the mode off), so this only shows while the first read is pending.
  if (!workspaceResolved) {
    return (
      <div
        className="flex h-full min-h-[240px] items-center justify-center text-sm"
        style={{ color: 'var(--hub-ink-3)' }}
      >
        {t('app.loading')}
      </div>
    );
  }

  const ctx = { isAdmin: Boolean(auth.user?.isAdmin), workspaceEnabled };
  if (!isRouteAllowed(pathname, ctx)) {
    return <Navigate to={fallbackPath(ctx)} replace />;
  }
  return (
    <>
      {workspaceLoadFailed && (
        <div
          className="hub-card mb-4 flex items-center justify-between gap-3 px-4 py-3 text-sm"
          role="alert"
        >
          <span style={{ color: 'var(--hub-err)' }}>{t('workspacePage.settingsFailed')}</span>
          <button type="button" className="hub-btn" onClick={() => void fetchSettings()}>
            {t('workspacePage.retry')}
          </button>
        </div>
      )}
      <Outlet />
    </>
  );
};

export default RouteAccessGuard;
