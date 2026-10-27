import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import ConnectedClientsPanel from '@/components/workspace/ConnectedClientsPanel';
import WorkspaceServicesView from '@/components/workspace/WorkspaceServicesView';

type WorkspaceTab = 'services' | 'clients';

// A query parameter rather than a nested route: the SPA is served with a relative asset base,
// so a deep link two segments down could not load its scripts after a reload.
const WorkspacePage: React.FC = () => {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const tab: WorkspaceTab = search.get('tab') === 'clients' ? 'clients' : 'services';

  const tabButton = (value: WorkspaceTab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === value}
      className={'hub-btn' + (tab === value ? ' primary' : '')}
      onClick={() => setSearch(value === 'clients' ? { tab: 'clients' } : {})}
    >
      {label}
    </button>
  );

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="hub-h1">{t('workspacePage.title')}</h1>
        <p className="hub-sub">{t('workspacePage.subtitle')}</p>
      </div>

      <div className="flex gap-2" role="tablist" aria-label={t('workspacePage.title')}>
        {tabButton('services', t('workspacePage.services.tab'))}
        {tabButton('clients', t('workspacePage.clients.tab'))}
      </div>

      {tab === 'clients' ? <ConnectedClientsPanel /> : <WorkspaceServicesView />}
    </div>
  );
};

export default WorkspacePage;
