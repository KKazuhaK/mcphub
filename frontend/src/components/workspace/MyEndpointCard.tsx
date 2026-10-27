import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';
import { EndpointCopy } from '@/components/ui/EndpointCopy';
import { useToast } from '@/contexts/ToastContext';
import { copyText } from '@/utils/clipboard';
import { getSmartRoutingPath } from '@/utils/runtime';
import {
  WORKSPACE_SNIPPET_CLIENTS,
  buildSmartEndpoint,
  buildWorkspaceSnippets,
} from '@/utils/workspace';
import type { ClientSnippetId } from '@/utils/mcpClientSnippets';

interface MyEndpointCardProps {
  aggregate: string;
  smartRoutingEnabled: boolean;
}

const SNIPPET_LABEL_KEYS: Partial<Record<ClientSnippetId, string>> = {
  'generic-mcp-servers': 'workspacePage.endpoint.clientGeneric',
  'claude-code': 'workspacePage.endpoint.clientClaude',
  cursor: 'workspacePage.endpoint.clientCursor',
};

const CopyBlock: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (!(await copyText(text))) {
      showToast(t('common.copyFailed'), 'error');
      return;
    }
    setCopied(true);
    showToast(t('common.copySuccess'), 'success');
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="relative">
      <pre
        className="hub-mono overflow-x-auto rounded-md p-3 pr-10 text-[12px]"
        style={{ background: 'var(--hub-bg-2)', border: '1px solid var(--hub-line)' }}
      >
        {text}
      </pre>
      <button
        type="button"
        className="hub-icon-btn absolute right-2 top-2"
        onClick={() => void onCopy()}
        aria-label={t('common.copy')}
        title={t('common.copy')}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
};

const MyEndpointCard: React.FC<MyEndpointCardProps> = ({ aggregate, smartRoutingEnabled }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'direct' | 'smart'>('direct');
  const [clientId, setClientId] = useState<ClientSnippetId>('generic-mcp-servers');

  const smartUrl = useMemo(() => buildSmartEndpoint(aggregate, getSmartRoutingPath()), [aggregate]);
  const activeUrl = mode === 'smart' ? smartUrl : aggregate;
  const blocks = useMemo(() => buildWorkspaceSnippets(clientId, activeUrl), [clientId, activeUrl]);

  const tabClass = (active: boolean) =>
    'hub-btn' + (active ? ' primary' : '') + ' !px-2.5 !py-1 text-[12px]';

  return (
    <section className="hub-card p-4 space-y-4" aria-labelledby="workspace-endpoint-title">
      <div>
        <h2 id="workspace-endpoint-title" className="font-semibold">
          {t('workspacePage.endpoint.title')}
        </h2>
        <p className="hub-sub mt-1">{t('workspacePage.endpoint.description')}</p>
      </div>

      <EndpointCopy
        url={aggregate}
        label={t('workspacePage.endpoint.direct')}
        ariaLabel={t('workspacePage.endpoint.direct')}
      />
      <EndpointCopy
        url={smartUrl}
        label={t('workspacePage.endpoint.smart')}
        ariaLabel={t('workspacePage.endpoint.smart')}
      />
      <p className="text-[12.5px]" style={{ color: 'var(--hub-ink-3)' }}>
        {t('workspacePage.endpoint.smartHint')}
        {!smartRoutingEnabled && <> {t('workspacePage.endpoint.smartDisabled')}</>}
      </p>

      <div className="space-y-2">
        <h3 className="text-[13px] font-medium">{t('workspacePage.endpoint.snippets')}</h3>
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label={t('workspacePage.endpoint.mode')}
        >
          {(['direct', 'smart'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={tabClass(mode === value)}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {t(`workspacePage.endpoint.mode_${value}`)}
            </button>
          ))}
        </div>
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label={t('workspacePage.endpoint.client')}
        >
          {WORKSPACE_SNIPPET_CLIENTS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={clientId === id}
              className={tabClass(clientId === id)}
              onClick={() => setClientId(id)}
            >
              {t(SNIPPET_LABEL_KEYS[id] ?? id)}
            </button>
          ))}
        </div>
        {blocks.map((block, index) => (
          <CopyBlock key={`${clientId}-${index}`} text={block.text} />
        ))}
        <p className="text-[12.5px]" style={{ color: 'var(--hub-ink-3)' }}>
          {t('workspacePage.endpoint.authNote')}
        </p>
      </div>
    </section>
  );
};

export default MyEndpointCard;
