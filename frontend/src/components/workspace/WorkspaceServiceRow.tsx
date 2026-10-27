import React from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import { StatusDot } from '@/components/ui/StatusDot';
import type { WorkspaceServer, WorkspaceServerEndpoint } from '@/types';
import {
  localizeStatusMessage,
  resolveServiceAction,
  statusTone,
  type ServiceAction,
} from '@/utils/workspace';

interface WorkspaceServiceRowProps {
  server: WorkspaceServer;
  endpoint?: WorkspaceServerEndpoint;
  credentialServers: ReadonlySet<string> | null;
  busy: boolean;
  // Set when the authorization popup was blocked.
  authorizationUrl?: string;
  onToggle: (name: string, selected: boolean) => void;
  onAction: (action: ServiceAction) => void;
  onCopyEndpoint: (url: string) => void;
}

const formatUntil = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};

const WorkspaceServiceRow: React.FC<WorkspaceServiceRowProps> = ({
  server,
  endpoint,
  credentialServers,
  busy,
  authorizationUrl,
  onToggle,
  onAction,
  onCopyEndpoint,
}) => {
  const { t } = useTranslation();
  const action = resolveServiceAction(server, credentialServers);
  const { code } = server.status;

  const renderAction = () => {
    switch (action.kind) {
      case 'select':
        return (
          <button
            type="button"
            className="hub-btn primary"
            disabled={busy}
            onClick={() => onAction(action)}
            aria-label={t('workspacePage.actions.selectFor', { name: server.name })}
          >
            {t('workspacePage.actions.select')}
          </button>
        );
      case 'credentials':
      case 'oauth':
        return (
          <button
            type="button"
            className="hub-btn primary"
            disabled={busy}
            onClick={() => onAction(action)}
            aria-label={t('workspacePage.actions.connectFor', { name: server.name })}
          >
            {t('workspacePage.actions.connect')}
          </button>
        );
      case 'contact_admin':
        return (
          <span className="text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
            {t('workspacePage.actions.contactAdmin')}
          </span>
        );
      case 'retry_later':
        return (
          <span className="text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
            {/* A maintenance message already carries the localized end time below. */}
            {action.until && code !== 'maintenance'
              ? t('workspacePage.actions.retryUntil', { until: formatUntil(action.until) })
              : t('workspacePage.actions.retryLater')}
          </span>
        );
      default:
        return null;
    }
  };

  const renderEndpoint = () => {
    if (!endpoint) return null;
    if (endpoint.url) {
      const { url } = endpoint;
      return (
        <button
          type="button"
          className="hub-icon-btn"
          onClick={() => onCopyEndpoint(url)}
          title={t('workspacePage.services.copyEndpoint')}
          aria-label={t('workspacePage.services.copyEndpointFor', { name: server.name })}
        >
          <Copy size={13} />
        </button>
      );
    }
    return (
      <button
        type="button"
        className="hub-icon-btn"
        disabled
        title={t('workspacePage.services.endpointConflict')}
        aria-label={t('workspacePage.services.endpointConflict')}
      >
        <Copy size={13} />
      </button>
    );
  };

  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
      style={{ borderTop: '1px solid var(--hub-line)' }}
      data-testid={`workspace-service-${server.name}`}
    >
      <button
        type="button"
        role="switch"
        aria-checked={server.selected}
        aria-label={t('workspacePage.services.toggleFor', { name: server.name })}
        className={'hub-switch compact' + (server.selected ? ' on' : '')}
        disabled={busy}
        onClick={() => onToggle(server.name, !server.selected)}
      />
      <div className="min-w-[180px] flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{server.name}</span>
          <StatusDot kind={statusTone(code)} label={t(`workspacePage.status.${code}`)} />
        </div>
        {server.description && (
          <div className="text-[12.5px]" style={{ color: 'var(--hub-ink-3)' }}>
            {server.description}
          </div>
        )}
        {code !== 'available' && code !== 'not_selected' && (
          <div className="mt-0.5 text-[12.5px]" style={{ color: 'var(--hub-ink-2)' }}>
            {localizeStatusMessage(server.status, formatUntil)}
          </div>
        )}
        {authorizationUrl && (
          <a
            href={authorizationUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-0.5 block text-[12.5px] underline"
          >
            {t('workspacePage.actions.openAuthorization')}
          </a>
        )}
      </div>
      <span className="hub-mono hub-num text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
        {t('workspacePage.services.toolCount', { count: server.toolCount })}
      </span>
      <div className="flex min-w-[96px] justify-end">{renderAction()}</div>
      <div className="flex w-8 justify-end">{renderEndpoint()}</div>
    </li>
  );
};

export default WorkspaceServiceRow;
