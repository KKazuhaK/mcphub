import React from 'react';
import { useTranslation } from 'react-i18next';
import { Copy } from 'lucide-react';
import { StatusDot } from '@/components/ui/StatusDot';
import type { ToolRiskLevel, WorkspaceServer, WorkspaceServerEndpoint } from '@/types';
import { TOOL_RISK_LEVELS, countHiddenByCeiling, isRiskChoiceAllowed } from '@/utils/toolRisk';
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
  onRiskChange: (name: string, riskCeiling: ToolRiskLevel) => void;
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
  onRiskChange,
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

  // How far the tools of this service may reach. Options above the administrator's cap stay
  // visible but cannot be chosen.
  const renderRisk = () => {
    if (!server.selected) return null;
    const hidden = countHiddenByCeiling(server.riskCounts, server.riskCeiling);
    return (
      <div className="basis-full" data-testid={`workspace-risk-${server.name}`}>
        <div className="mb-1 text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
          {t('workspacePage.risk.explanation')}
        </div>
        <div
          role="radiogroup"
          aria-label={t('workspacePage.risk.groupLabel', { name: server.name })}
          className="flex flex-wrap gap-2"
        >
          {TOOL_RISK_LEVELS.map((level) => {
            const allowed = isRiskChoiceAllowed(level, server.maxAllowedRisk);
            const checked = server.riskCeiling === level;
            return (
              <button
                key={level}
                type="button"
                role="radio"
                aria-checked={checked}
                disabled={busy || !allowed}
                title={
                  allowed
                    ? t(`workspacePage.risk.level.${level}.hint`)
                    : t('workspacePage.risk.aboveCap')
                }
                className={'hub-btn' + (checked ? ' primary' : '')}
                data-risk-level={level}
                onClick={() => !checked && onRiskChange(server.name, level)}
              >
                {t(`workspacePage.risk.level.${level}.label`)}
                <span className="hub-mono hub-num ml-1.5 text-[11.5px] opacity-80">
                  {server.riskCounts
                    ? t('workspacePage.services.toolCount', {
                        count: server.riskCounts[level] || 0,
                      })
                    : null}
                </span>
              </button>
            );
          })}
        </div>
        {!server.riskCounts && (
          <div className="mt-1 text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
            {t('workspacePage.risk.connectToSee')}
          </div>
        )}
        {server.riskCeilingIsDefault && server.riskCounts && (
          <div className="mt-1 text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
            {t('workspacePage.risk.defaultNote')}
          </div>
        )}
        {!server.annotationsTrusted && (
          <div className="mt-1 text-[12px]" style={{ color: 'var(--hub-ink-3)' }}>
            {t('workspacePage.risk.untrustedHint')}
          </div>
        )}
        {hidden > 0 && (
          <div role="status" className="mt-1 text-[12px]" style={{ color: 'var(--hub-warn)' }}>
            {t('workspacePage.risk.hiddenNotice', { count: hidden })}
          </div>
        )}
      </div>
    );
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
        {server.toolCount === null
          ? t('workspacePage.risk.unknownTools')
          : t('workspacePage.services.toolCount', { count: server.toolCount })}
      </span>
      <div className="flex min-w-[96px] justify-end">{renderAction()}</div>
      <div className="flex w-8 justify-end">{renderEndpoint()}</div>
      {renderRisk()}
    </li>
  );
};

export default WorkspaceServiceRow;
