import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink } from 'react-router-dom';
import {
  LayoutGrid,
  Server as ServerIcon,
  Users as UsersIcon,
  Store,
  Route as RouteIcon,
  Settings as SettingsIcon,
  FileText,
  MessageSquare,
  Activity,
  ScrollText,
  KeyRound,
  Briefcase,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { useServerContext } from '@/contexts/ServerContext';
import { useGroupData } from '@/hooks/useGroupData';
import { useSettings } from '@/contexts/SettingsContext';
import {
  canViewSystemLogs,
  getWorkspaceNavKeys,
  type NavKey,
} from '@/utils/navigationPermissions';
import { usePermissionCheck } from '../PermissionChecker';
import UserProfileMenu from '@/components/ui/UserProfileMenu';
import { APP_VERSION } from '@/utils/appVersion';
import { checkActivityAvailable } from '@/services/activityService';

interface SidebarProps {
  collapsed: boolean;
}

interface MenuItem {
  path: string;
  label: string;
  icon: React.ReactNode;
  badge?: string | number;
  end?: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({ collapsed }) => {
  const { t } = useTranslation();
  const { auth } = useAuth();
  const { allServers } = useServerContext();
  const { groups } = useGroupData();
  const { workspaceEnabled, workspaceResolved } = useSettings();
  const [activityAvailable, setActivityAvailable] = useState(false);

  const appVersion = APP_VERSION;

  useEffect(() => {
    checkActivityAvailable()
      .then(setActivityAvailable)
      .catch(() => setActivityAvailable(false));
  }, []);

  const userCanManageUsers = auth.user?.isAdmin && usePermissionCheck('x');

  const allWorkspaceItems: Record<NavKey, MenuItem> = {
    workspace: {
      path: '/workspace',
      label: t('workspacePage.nav'),
      icon: <Briefcase className="h-4 w-4" />,
    },
    dashboard: {
      path: '/',
      label: t('nav.dashboard'),
      icon: <LayoutGrid className="h-4 w-4" />,
      end: true,
    },
    servers: {
      path: '/servers',
      label: t('nav.servers'),
      icon: <ServerIcon className="h-4 w-4" />,
      badge: allServers.length || undefined,
    },
    groups: {
      path: '/groups',
      label: t('nav.groups'),
      icon: <RouteIcon className="h-4 w-4" />,
      badge: groups.length || undefined,
    },
    prompts: {
      path: '/prompts',
      label: t('nav.prompts'),
      icon: <MessageSquare className="h-4 w-4" />,
    },
    resources: {
      path: '/resources',
      label: t('nav.resources'),
      icon: <FileText className="h-4 w-4" />,
    },
    market: { path: '/market', label: t('nav.market'), icon: <Store className="h-4 w-4" /> },
  };
  const workspaceItems: MenuItem[] = getWorkspaceNavKeys({
    isAdmin: Boolean(auth.user?.isAdmin),
    workspaceEnabled,
    resolved: workspaceResolved,
  }).map((key) => allWorkspaceItems[key]);

  const systemItems: MenuItem[] = [
    ...(userCanManageUsers
      ? [{ path: '/users', label: t('nav.users'), icon: <UsersIcon className="h-4 w-4" /> }]
      : []),
    ...(activityAvailable && auth.user?.isAdmin
      ? [{ path: '/activity', label: t('nav.activity'), icon: <Activity className="h-4 w-4" /> }]
      : []),
    ...(canViewSystemLogs(auth.user)
      ? [{ path: '/logs', label: t('nav.logs'), icon: <ScrollText className="h-4 w-4" /> }]
      : []),
    { path: '/credentials', label: t('credentials.title'), icon: <KeyRound className="h-4 w-4" /> },
    { path: '/settings', label: t('nav.settings'), icon: <SettingsIcon className="h-4 w-4" /> },
  ];

  const renderItem = (item: MenuItem) => (
    <NavLink
      key={item.path}
      to={item.path}
      end={item.end}
      className={({ isActive }) =>
        [
          // Icons sit 20px from the edge in both states, so collapsing never shifts them.
          'group relative flex h-8 items-center gap-2.5 rounded-md text-[14px] transition-colors duration-100',
          collapsed ? 'justify-center' : 'px-3',
          isActive
            ? 'bg-[var(--hub-surface)] font-medium text-[var(--hub-ink)] shadow-[var(--hub-shadow-resting)] ring-1 ring-inset ring-[var(--hub-line)]'
            : 'text-[var(--hub-ink-2)] hover:bg-[var(--hub-surface-hover)] hover:text-[var(--hub-ink)]',
        ].join(' ')
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={
              isActive
                ? 'text-[var(--hub-ink)] flex-shrink-0'
                : 'text-[var(--hub-ink-3)] transition-colors duration-100 group-hover:text-[var(--hub-ink-2)] flex-shrink-0'
            }
          >
            {item.icon}
          </span>
          {!collapsed && (
            <>
              <span className="hub-sidebar-label truncate">{item.label}</span>
              {item.badge != null && (
                <span className="hub-sidebar-label ml-auto hub-mono hub-num text-[12px] font-normal text-[var(--hub-ink-3)]">
                  {item.badge}
                </span>
              )}
            </>
          )}
        </>
      )}
    </NavLink>
  );

  return (
    <aside
      className={
        'flex flex-col h-full relative shrink-0 ' +
        'transition-[width] duration-200 ease-[cubic-bezier(0.6,0,0.2,1)] ' +
        'bg-[var(--hub-bg-2)] border-r border-[var(--hub-line)] ' +
        (collapsed ? 'w-14' : 'w-[232px]')
      }
    >
      {/* Brand */}
      {/* Same height as the top bar, so their bottom borders form one line. */}
      <div
        className={
          'flex h-12 shrink-0 items-center gap-2.5 overflow-hidden border-b border-[var(--hub-line)] ' +
          (collapsed ? 'justify-center' : 'px-3.5')
        }
      >
        <div
          className="relative grid h-7 w-7 shrink-0 place-items-center rounded-md text-white hub-mono text-[12px] font-semibold"
          style={{
            background:
              'linear-gradient(135deg, var(--hub-accent), oklch(0.62 0.18 285))',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.14)',
          }}
        >
          <span>M</span>
          <span
            className="absolute -right-0.5 -bottom-0.5 w-[6px] h-[6px] rounded-full"
            style={{
              background: 'var(--hub-ok)',
              boxShadow: '0 0 0 2px oklch(0.66 0.15 145 / 0.18)',
            }}
          />
        </div>
        {!collapsed && (
          <div className="hub-sidebar-label flex min-w-0 flex-col leading-tight">
            <span className="truncate text-[14px] font-semibold tracking-tight text-[var(--hub-ink)]">
              {t('app.title')}
            </span>
            {appVersion && (
              <span className="hub-mono truncate text-[11px] text-[var(--hub-ink-3)]">
                {appVersion === 'dev' ? appVersion : `v${appVersion}`}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden py-2">
        {!collapsed && (
          <div className="hub-sect hub-sidebar-label px-5 pt-2 pb-2">{t('nav.workspace')}</div>
        )}
        <nav className={'flex flex-col gap-0.5 ' + (collapsed ? 'px-1.5' : 'px-2')}>
          {workspaceItems.map(renderItem)}
        </nav>

        {collapsed ? (
          <div className="mx-3 my-3 border-t border-[var(--hub-line)]" />
        ) : (
          <div className="hub-sect hub-sidebar-label px-5 pt-5 pb-2">{t('nav.system')}</div>
        )}
        <nav className={'flex flex-col gap-0.5 ' + (collapsed ? 'px-1.5' : 'px-2')}>
          {systemItems.map(renderItem)}
        </nav>
      </div>

      <div className="p-2.5 border-t border-[var(--hub-line)]">
        <UserProfileMenu collapsed={collapsed} version={appVersion} />
      </div>
    </aside>
  );
};

export default Sidebar;
