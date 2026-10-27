import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { toolCountLevel } from '@/utils/workspace';

interface ToolCountIndicatorProps {
  total: number;
}

const ToolCountIndicator: React.FC<ToolCountIndicatorProps> = ({ total }) => {
  const { t } = useTranslation();
  const level = toolCountLevel(total);
  const color =
    level === 'strong'
      ? 'var(--hub-err)'
      : level === 'warn'
        ? 'var(--hub-warn)'
        : 'var(--hub-ink-3)';

  return (
    <div className="hub-card px-4 py-3" data-level={level}>
      <div className="flex items-baseline gap-2">
        <span className="hub-num text-[22px] font-medium" style={{ color: 'var(--hub-ink)' }}>
          {total}
        </span>
        <span className="text-[13px]" style={{ color: 'var(--hub-ink-2)' }}>
          {t('workspacePage.tools.label', { count: total })}
        </span>
      </div>
      {level !== 'ok' && (
        <p
          role="status"
          className="mt-2 flex items-start gap-2 text-[12.5px]"
          style={{ color: 'var(--hub-ink-2)' }}
        >
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" style={{ color }} aria-hidden />
          <span>
            {t(
              level === 'strong'
                ? 'workspacePage.tools.strongWarning'
                : 'workspacePage.tools.warning',
              {
                count: total,
              },
            )}
          </span>
        </p>
      )}
    </div>
  );
};

export default ToolCountIndicator;
