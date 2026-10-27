import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useToast } from '../../contexts/ToastContext';
import {
  fetchWorkspaceClients,
  revokeAllWorkspaceClients,
  revokeWorkspaceClient,
} from '../../services/workspaceService';
import type { WorkspaceClient } from '../../types';
import { WorkspaceApiError } from '../../utils/workspace';

const formatTime = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const ConnectedClientsPanel: React.FC = () => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [clients, setClients] = useState<WorkspaceClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ detail: string; disabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<WorkspaceClient | null>(null);
  const [revokingAll, setRevokingAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setClients(await fetchWorkspaceClients());
      setError(null);
    } catch (err) {
      setError({
        detail: err instanceof Error ? err.message : '',
        disabled: err instanceof WorkspaceApiError && err.disabled,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<void>, successKey: string) => {
    setBusy(true);
    try {
      await action();
      showToast(t(successKey), 'success');
    } catch (err) {
      showToast(
        t('workspacePage.clients.revokeFailed') +
          (err instanceof Error && err.message ? ` (${err.message})` : ''),
        'error',
      );
    } finally {
      setBusy(false);
      await load();
    }
  };

  const confirmRevoke = async () => {
    const target = revoking;
    setRevoking(null);
    if (target) {
      await run(() => revokeWorkspaceClient(target), 'workspacePage.clients.revoked');
    }
  };

  const confirmRevokeAll = async () => {
    setRevokingAll(false);
    await run(revokeAllWorkspaceClients, 'workspacePage.clients.revokedAll');
  };

  const never = t('workspacePage.clients.never');

  return (
    <section className="hub-card overflow-hidden" aria-labelledby="workspace-clients-title">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div>
          <h2 id="workspace-clients-title" className="font-semibold">
            {t('workspacePage.clients.title')}
          </h2>
          <p className="hub-sub">{t('workspacePage.clients.description')}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" className="hub-btn" onClick={() => void load()}>
            <RefreshCw size={13} /> {t('common.refresh')}
          </button>
          <button
            type="button"
            className="hub-btn danger"
            disabled={busy || clients.length === 0}
            onClick={() => setRevokingAll(true)}
          >
            {t('workspacePage.clients.revokeAll')}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 px-4 pb-3 text-sm" role="alert">
          <div>
            <div style={{ color: 'var(--hub-err)' }}>
              {t(error.disabled ? 'workspacePage.disabled' : 'workspacePage.clients.loadFailed')}
            </div>
            {error.detail && !error.disabled && (
              <div className="text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
                {error.detail}
              </div>
            )}
          </div>
          {error.disabled && (
            <button type="button" className="hub-btn" onClick={() => window.location.reload()}>
              {t('workspacePage.reload')}
            </button>
          )}
        </div>
      )}

      {loading ? (
        <p className="px-4 pb-6 text-center text-sm" style={{ color: 'var(--hub-ink-3)' }}>
          {t('workspacePage.loading')}
        </p>
      ) : clients.length === 0 ? (
        <p className="px-4 pb-6 text-center text-sm" style={{ color: 'var(--hub-ink-3)' }}>
          {t('workspacePage.clients.empty')}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr style={{ color: 'var(--hub-ink-3)', borderTop: '1px solid var(--hub-line)' }}>
                {['name', 'kind', 'created', 'lastUsed', 'expires'].map((column) => (
                  <th key={column} scope="col" className="px-4 py-2 font-medium">
                    {t(`workspacePage.clients.columns.${column}`)}
                  </th>
                ))}
                <th scope="col" className="px-4 py-2">
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr
                  key={`${client.kind}:${client.id}`}
                  style={{ borderTop: '1px solid var(--hub-line)' }}
                >
                  <td className="px-4 py-2.5">
                    <span className="font-medium">{client.name}</span>
                    {client.idle && (
                      <span className="hub-tag ml-2" title={t('workspacePage.clients.idleHint')}>
                        {t('workspacePage.clients.idle')}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className="hub-tag">
                      {t(`workspacePage.clients.kind.${client.kind}`)}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">{formatTime(client.createdAt) ?? never}</td>
                  <td className="px-4 py-2.5">{formatTime(client.lastUsedAt) ?? never}</td>
                  <td className="px-4 py-2.5">{formatTime(client.expiresAt) ?? '-'}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      className="hub-btn danger"
                      disabled={busy}
                      onClick={() => setRevoking(client)}
                      aria-label={t('workspacePage.clients.revokeFor', { name: client.name })}
                    >
                      {t('workspacePage.clients.revoke')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmDialog
        isOpen={revoking !== null}
        onClose={() => setRevoking(null)}
        onConfirm={() => void confirmRevoke()}
        variant="danger"
        title={t('workspacePage.clients.revokeTitle')}
        message={t('workspacePage.clients.revokeMessage', { name: revoking?.name ?? '' })}
        confirmText={t('workspacePage.clients.revoke')}
      />
      <ConfirmDialog
        isOpen={revokingAll}
        onClose={() => setRevokingAll(false)}
        onConfirm={() => void confirmRevokeAll()}
        variant="danger"
        title={t('workspacePage.clients.revokeAllTitle')}
        message={t('workspacePage.clients.revokeAllMessage')}
        confirmText={t('workspacePage.clients.revokeAll')}
      />
    </section>
  );
};

export default ConnectedClientsPanel;
