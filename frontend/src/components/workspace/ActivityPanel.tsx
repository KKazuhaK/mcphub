import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import {
  fetchWorkspaceActivity,
  fetchWorkspaceClients,
  fetchWorkspaceServers,
} from '../../services/workspaceService';
import type { WorkspaceActivityItem, WorkspaceActivityStatus } from '../../types';
import {
  WorkspaceApiError,
  activityReasonKey,
  appendActivityItems,
  createLatestOnly,
  mergeActivityClientOptions,
  mergeActivityOptions,
  type ActivityFilters,
} from '../../utils/workspace';

const RESULTS: WorkspaceActivityStatus[] = ['success', 'error', 'blocked'];
const STATUS_TONE: Record<WorkspaceActivityStatus, string> = {
  success: 'ok',
  error: 'err',
  blocked: 'warn',
};

const formatTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const ActivityPanel: React.FC = () => {
  const { t } = useTranslation();
  const [items, setItems] = useState<WorkspaceActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ detail: string; disabled: boolean } | null>(null);
  const [available, setAvailable] = useState(true);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filters, setFilters] = useState<ActivityFilters>({});
  const [knownServers, setKnownServers] = useState<string[]>([]);
  const [knownClients, setKnownClients] = useState<
    Array<{ kind: 'oauth' | 'key'; id: string; name: string }>
  >([]);
  // Only the newest request may write state: a slow answer for old filters must not replace
  // the rows for the current ones, and a page for old filters must not be appended to new ones.
  const latest = useRef(createLatestOnly());

  const describeError = (err: unknown) => ({
    detail: err instanceof Error ? err.message : '',
    disabled: err instanceof WorkspaceApiError && err.disabled,
  });

  const load = useCallback(async (next: ActivityFilters) => {
    setLoading(true);
    try {
      await latest.current.run(
        () => fetchWorkspaceActivity(next),
        (page) => {
          setAvailable(page.available);
          setItems(page.available ? page.items : []);
          setNextCursor(page.available ? page.nextCursor : null);
          setError(null);
          setLoading(false);
        },
      );
    } catch (err) {
      setError(describeError(err));
      setLoading(false);
    }
  }, []);

  const loadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      await latest.current.run(
        () => fetchWorkspaceActivity(filters, nextCursor),
        (page) => {
          if (!page.available) return;
          setItems((current) => appendActivityItems(current, page.items));
          setNextCursor(page.nextCursor);
          setError(null);
        },
      );
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

  // Filter choices come from the user's services and clients; failures just leave them short.
  useEffect(() => {
    fetchWorkspaceServers()
      .then((servers) => setKnownServers(servers.map((server) => server.name)))
      .catch(() => undefined);
    fetchWorkspaceClients()
      .then((clients) => setKnownClients(clients.map(({ kind, id, name }) => ({ kind, id, name }))))
      .catch(() => undefined);
  }, []);

  const setFilter = (patch: Partial<ActivityFilters>) =>
    setFilters((current) => {
      const merged = { ...current, ...patch };
      return Object.fromEntries(
        Object.entries(merged).filter(([, value]) => value),
      ) as ActivityFilters;
    });

  const serverOptions = mergeActivityOptions(knownServers, items, filters.server);
  const clientOptions = mergeActivityClientOptions(knownClients, items, filters.client);
  const filtered = Boolean(filters.server || filters.status || filters.client);

  const clientLabel = (item: WorkspaceActivityItem): string => {
    if (!item.client) return t('workspacePage.activity.noClient');
    if (!item.client.name) return t('workspacePage.activity.unknownClient');
    return item.client.active
      ? item.client.name
      : t('workspacePage.activity.clientGone', { name: item.client.name });
  };

  return (
    <section className="hub-card overflow-hidden" aria-labelledby="workspace-activity-title">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h2 id="workspace-activity-title" className="font-semibold">
            {t('workspacePage.activity.title')}
          </h2>
          <p className="hub-sub">{t('workspacePage.activity.description')}</p>
        </div>
        {available && (
          <button type="button" className="hub-btn" onClick={() => void load(filters)}>
            <RefreshCw size={13} /> {t('common.refresh')}
          </button>
        )}
      </div>

      {available && (
        <div
          className="flex flex-wrap gap-3 px-4 pb-3"
          role="group"
          aria-label={t('workspacePage.activity.filters.label')}
        >
          <label className="flex flex-col gap-1 text-[12px]">
            {t('workspacePage.activity.filters.service')}
            <select
              className="hub-input"
              value={filters.server ?? ''}
              onChange={(event) => setFilter({ server: event.target.value || undefined })}
            >
              <option value="">{t('workspacePage.activity.filters.allServices')}</option>
              {serverOptions.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            {t('workspacePage.activity.filters.result')}
            <select
              className="hub-input"
              value={filters.status ?? ''}
              onChange={(event) =>
                setFilter({ status: (event.target.value || undefined) as WorkspaceActivityStatus })
              }
            >
              <option value="">{t('workspacePage.activity.filters.allResults')}</option>
              {RESULTS.map((result) => (
                <option key={result} value={result}>
                  {t(`workspacePage.activity.result.${result}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-[12px]">
            {t('workspacePage.activity.filters.client')}
            <select
              className="hub-input"
              value={filters.client ?? ''}
              onChange={(event) => setFilter({ client: event.target.value || undefined })}
            >
              <option value="">{t('workspacePage.activity.filters.allClients')}</option>
              {clientOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.name ?? t('workspacePage.activity.unknownClient')}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {error && (
        <div className="px-4 pb-3 text-sm" role="alert">
          <div style={{ color: 'var(--hub-err)' }}>
            {t(error.disabled ? 'workspacePage.disabled' : 'workspacePage.activity.loadFailed')}
          </div>
          {error.detail && !error.disabled && (
            <div className="text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
              {error.detail}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <p className="px-4 pb-6 text-center text-sm" style={{ color: 'var(--hub-ink-3)' }}>
          {t('workspacePage.loading')}
        </p>
      ) : !available ? (
        <div className="px-4 pb-6 text-center text-sm" role="status">
          <p className="font-medium">{t('workspacePage.activity.unavailableTitle')}</p>
          <p style={{ color: 'var(--hub-ink-3)' }}>{t('workspacePage.activity.unavailableBody')}</p>
        </div>
      ) : items.length === 0 ? (
        <p className="px-4 pb-6 text-center text-sm" style={{ color: 'var(--hub-ink-3)' }}>
          {t(filtered ? 'workspacePage.activity.emptyFiltered' : 'workspacePage.activity.empty')}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead>
                <tr style={{ color: 'var(--hub-ink-3)', borderTop: '1px solid var(--hub-line)' }}>
                  {['time', 'service', 'tool', 'client', 'result', 'reason'].map((column) => (
                    <th key={column} scope="col" className="px-4 py-2 font-medium">
                      {t(`workspacePage.activity.columns.${column}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const reasonKey = activityReasonKey(item);
                  return (
                    <tr key={item.id} style={{ borderTop: '1px solid var(--hub-line)' }}>
                      <td className="px-4 py-2.5 whitespace-nowrap">
                        <time dateTime={item.timestamp}>{formatTime(item.timestamp)}</time>
                      </td>
                      <td className="px-4 py-2.5">{item.server}</td>
                      <td className="px-4 py-2.5">
                        <span className="hub-tag">{item.tool}</span>
                      </td>
                      <td className="px-4 py-2.5">{clientLabel(item)}</td>
                      <td className="px-4 py-2.5">
                        <span className={`hub-status ${STATUS_TONE[item.status]}`}>
                          <span className="hub-dot" aria-hidden="true" />
                          {t(`workspacePage.activity.result.${item.status}`)}
                        </span>
                        <span className="ml-2 text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
                          {t('workspacePage.activity.duration', { ms: item.durationMs })}
                        </span>
                      </td>
                      <td className="px-4 py-2.5">{reasonKey ? t(reasonKey) : '-'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div
            className="flex items-center justify-between gap-3 px-4 py-3 text-[12px]"
            style={{ color: 'var(--hub-ink-3)', borderTop: '1px solid var(--hub-line)' }}
          >
            <span>{t('workspacePage.activity.shown', { count: items.length })}</span>
            {nextCursor && (
              <button
                type="button"
                className="hub-btn"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore
                  ? t('workspacePage.activity.loadingMore')
                  : t('workspacePage.activity.loadMore')}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
};

export default ActivityPanel;
