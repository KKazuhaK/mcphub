import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../contexts/AuthContext';
import { getLoginRedirectPath } from '../utils/serviceLink';

interface ProtectedRouteProps {
  redirectPath?: string;
}

const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ redirectPath = '/login' }) => {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const { pathname, search } = useLocation();

  if (auth.loading) {
    return <div className="flex items-center justify-center h-screen">{t('app.loading')}</div>;
  }

  if (!auth.isAuthenticated) {
    // The caller's own redirect target wins; otherwise a service link returns here after login.
    const target =
      redirectPath === '/login' ? getLoginRedirectPath(pathname, search) : redirectPath;
    return <Navigate to={target} replace />;
  }

  return <Outlet />;
};

export default ProtectedRoute;
