import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, Info, RefreshCw } from 'lucide-react';
import { useSettings } from '@/contexts/SettingsContext';
import { useToast } from '@/contexts/ToastContext';
import {
  fetchCredentialServerNames,
  fetchWorkspaceEndpoints,
  fetchWorkspaceServers,
  fetchWorkspaceSummary,
  saveServerSelection,
  startPersonalOAuth,
} from '@/services/workspaceService';
import type { WorkspaceEndpoints, WorkspaceServer, WorkspaceSummary } from '@/types';
import { copyText } from '@/utils/clipboard';
import {
  WorkspaceApiError,
  countExposedTools,
  createLatestOnly,
  credentialsPath,
  pruneAuthLinks,
  resolveOAuthLaunch,
  resolveSummaryBanner,
  shouldRefreshOnFocus,
  toggleServerSelection,
  type ServiceAction,
} from '@/utils/workspace';
import MyEndpointCard from './MyEndpointCard';
import ToolCountIndicator from './ToolCountIndicator';
import WorkspaceServiceRow from './WorkspaceServiceRow';

const SummaryBannerView: React.FC<{ summary: WorkspaceSummary }> = ({ summary }) => {
  const { t } = useTranslation();
  const banner = resolveSummaryBanner(summary);
  const tone = banner.kind === 'normal' ? 'ok' : banner.kind === 'none_selected' ? 'info' : 'warn';
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'info' ? Info : AlertTriangle;
  const color =
    tone === 'ok' ? 'var(--hub-ok)' : tone === 'warn' ? 'var(--hub-warn)' : 'var(--hub-ink-3)';
  const text = {
    normal: t('workspacePage.banner.normal', { count: banner.selected }),
    partial: t('workspacePage.banner.partial', {
      count: banner.selected,
      attention: banner.attention,
      selected: banner.selected,
    }),
    none_selected: t('workspacePage.banner.noneSelected'),
    none_usable: t('workspacePage.banner.noneUsable', { count: banner.selected }),
  }[banner.kind];

  return (
    <div
      className="hub-card flex items-center gap-3 px-4 py-3 text-[13.5px]"
      role="status"
      data-banner={banner.kind}
    >
      <Icon size={18} style={{ color }} aria-hidden />
      <span>{text}</span>
    </div>
  );
};

const WorkspaceServicesView: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { smartRoutingConfig } = useSettings();

  const [servers, setServers] = useState<WorkspaceServer[]>([]);
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  const [endpoints, setEndpoints] = useState<WorkspaceEndpoints | null>(null);
  const [credentialServers, setCredentialServers] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ detail: string; disabled: boolean } | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [authLinks, setAuthLinks] = useState<Record<string, string>>({});
  // Selection saves in flight, readable from event handlers without a re-render.
  const pendingRef = useRef(0);
  // Only the newest refresh may write state; a slow stale one must not undo a newer view.
  const latest = useRef(createLatestOnly());

  const refreshAll = useCallback(
    () =>
      latest.current
        .run(
          () =>
            Promise.all([
              fetchWorkspaceServers(),
              fetchWorkspaceSummary(),
              fetchWorkspaceEndpoints(),
            ]),
          ([serverList, nextSummary, nextEndpoints]) => {
            setServers(serverList);
            // A blocked-popup link is moot once the server no longer asks for sign-in.
            setAuthLinks((links) => pruneAuthLinks(links, serverList));
            setSummary(nextSummary);
            setEndpoints(nextEndpoints);
            setError(null);
          },
        )
        .then(() => undefined),
    [],
  );

  const load = useCallback(async () => {
    try {
      await refreshAll();
    } catch (err) {
      setError({
        detail: err instanceof Error ? err.message : '',
        disabled: err instanceof WorkspaceApiError && err.disabled,
      });
    } finally {
      setLoading(false);
    }
  }, [refreshAll]);

  useEffect(() => {
    void load();
    // Servers with credential slots decide where "Connect" leads; failure falls back safely.
    fetchCredentialServerNames()
      .then(setCredentialServers)
      .catch(() => setCredentialServers(null));
  }, [load]);

  // Coming back from the credentials page or an OAuth tab: pick up the new status.
  useEffect(() => {
    const onFocus = () => {
      if (shouldRefreshOnFocus(pendingRef.current)) void refreshAll().catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshAll]);

  const withPending = async (name: string, run: () => Promise<void>) => {
    setPending((current) => new Set(current).add(name));
    pendingRef.current++;
    // A refresh started earlier would carry the pre-change state back over the change.
    latest.current.invalidate();
    try {
      await run();
    } finally {
      pendingRef.current--;
      setPending((current) => {
        const next = new Set(current);
        next.delete(name);
        return next;
      });
    }
  };

  const onToggle = (name: string, selected: boolean) =>
    withPending(name, async () => {
      const saved = await toggleServerSelection(name, selected, {
        save: saveServerSelection,
        update: (updater) => setServers(updater),
      });
      if (!saved) {
        showToast(t('workspacePage.toggleFailed', { name }), 'error');
        return;
      }
      await refreshAll().catch(() => undefined);
    });

  const connectOAuth = (name: string) =>
    withPending(name, async () => {
      // Opened during the click gesture; browsers may block popups after awaits. Cutting the
      // opener link keeps the identity provider's page from reaching back into this one.
      const popup = window.open('about:blank', '_blank');
      if (popup) popup.opener = null;
      try {
        const launch = resolveOAuthLaunch(await startPersonalOAuth(name), Boolean(popup));
        if (launch.kind === 'navigate') {
          popup?.location.replace(launch.url);
        } else {
          popup?.close();
          if (launch.kind === 'link') {
            setAuthLinks((links) => ({ ...links, [name]: launch.url }));
            showToast(t('workspacePage.popupBlocked'), 'error');
          } else if (launch.kind === 'invalid') {
            showToast(t('workspacePage.connectFailed'), 'error');
          }
        }
        await refreshAll().catch(() => undefined);
      } catch (err) {
        popup?.close();
        showToast(
          t('workspacePage.connectFailed') +
            (err instanceof Error && err.message ? ` (${err.message})` : ''),
          'error',
        );
      }
    });

  const onAction = (server: WorkspaceServer, action: ServiceAction) => {
    if (action.kind === 'select') void onToggle(server.name, true);
    else if (action.kind === 'credentials') navigate(credentialsPath(server.name));
    else if (action.kind === 'oauth') void connectOAuth(server.name);
  };

  const onCopyEndpoint = async (url: string) => {
    if (await copyText(url)) showToast(t('common.copySuccess'), 'success');
    else showToast(t('common.copyFailed'), 'error');
  };

  if (loading) {
    return (
      <div className="hub-card p-10 text-center text-sm" style={{ color: 'var(--hub-ink-3)' }}>
        {t('workspacePage.loading')}
      </div>
    );
  }

  if (error && !summary) {
    return (
      <div className="hub-card flex items-center justify-between gap-3 px-4 py-3 text-sm" role="alert">
        <div>
          <div style={{ color: 'var(--hub-err)' }}>
            {t(error.disabled ? 'workspacePage.disabled' : 'workspacePage.loadFailed')}
          </div>
          {error.detail && !error.disabled && (
            <div className="text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
              {error.detail}
            </div>
          )}
        </div>
        <button
          type="button"
          className="hub-btn"
          onClick={() => (error.disabled ? window.location.reload() : void load())}
        >
          <RefreshCw size={13} /> {t(error.disabled ? 'workspacePage.reload' : 'workspacePage.retry')}
        </button>
      </div>
    );
  }

  const endpointByName = new Map((endpoints?.servers ?? []).map((entry) => [entry.name, entry]));

  return (
    <div className="space-y-4">
      {summary && <SummaryBannerView summary={summary} />}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
        {endpoints && (
          <MyEndpointCard
            aggregate={endpoints.aggregate}
            smartRoutingEnabled={smartRoutingConfig.enabled}
          />
        )}
        <ToolCountIndicator total={countExposedTools(servers)} />
      </div>

      <section className="hub-card overflow-hidden" aria-labelledby="workspace-services-title">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div>
            <h2 id="workspace-services-title" className="font-semibold">
              {t('workspacePage.services.title')}
            </h2>
            <p className="hub-sub">{t('workspacePage.services.description')}</p>
          </div>
          <button
            type="button"
            className="hub-btn"
            onClick={() => void refreshAll().catch(() => undefined)}
          >
            <RefreshCw size={13} /> {t('common.refresh')}
          </button>
        </div>
        {servers.length === 0 ? (
          <p className="px-4 pb-6 text-center text-sm" style={{ color: 'var(--hub-ink-3)' }}>
            {t('workspacePage.services.empty')}
          </p>
        ) : (
          <ul>
            {servers.map((server) => (
              <WorkspaceServiceRow
                key={server.name}
                server={server}
                endpoint={endpointByName.get(server.name)}
                credentialServers={credentialServers}
                busy={pending.has(server.name)}
                authorizationUrl={authLinks[server.name]}
                onToggle={(name, selected) => void onToggle(name, selected)}
                onAction={(action) => onAction(server, action)}
                onCopyEndpoint={(url) => void onCopyEndpoint(url)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};

export default WorkspaceServicesView;
