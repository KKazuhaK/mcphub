import React from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import ActivityPanel from '@/components/workspace/ActivityPanel';
import ConnectedClientsPanel from '@/components/workspace/ConnectedClientsPanel';
import WorkspaceServicesView from '@/components/workspace/WorkspaceServicesView';

type WorkspaceTab = 'services' | 'clients' | 'activity';

// A query parameter rather than a nested route: the SPA is served with a relative asset base,
// so a deep link two segments down could not load its scripts after a reload.
const WorkspacePage: React.FC = () => {
  const { t } = useTranslation();
  const [search, setSearch] = useSearchParams();
  const requested = search.get('tab');
  const tab: WorkspaceTab =
    requested === 'clients' || requested === 'activity' ? requested : 'services';

  const tabButton = (value: WorkspaceTab, label: string) => (
    <button
      type="button"
      role="tab"
      id={`workspace-tab-${value}`}
      aria-controls="workspace-tabpanel"
      aria-selected={tab === value}
      className="hub-tab"
      onClick={() => setSearch(value === 'services' ? {} : { tab: value })}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="hub-h1">{t('workspacePage.title')}</h1>
        <p className="hub-sub">{t('workspacePage.subtitle')}</p>
      </div>

      <div className="hub-tabs" role="tablist" aria-label={t('workspacePage.title')}>
        {tabButton('services', t('workspacePage.services.tab'))}
        {tabButton('clients', t('workspacePage.clients.tab'))}
        {tabButton('activity', t('workspacePage.activity.tab'))}
      </div>

      <div
        key={tab}
        id="workspace-tabpanel"
        className="hub-reveal"
        role="tabpanel"
        aria-labelledby={`workspace-tab-${tab}`}
      >
        {tab === 'clients' ? (
          <ConnectedClientsPanel />
        ) : tab === 'activity' ? (
          <ActivityPanel />
        ) : (
          <WorkspaceServicesView />
        )}
      </div>
    </div>
  );
};

export default WorkspacePage;
