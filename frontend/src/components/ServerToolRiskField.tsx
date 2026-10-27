import { useTranslation } from 'react-i18next';
import type { ToolRiskLevel } from '@/types';
import { TOOL_RISK_LEVELS, clampDefaultToCap, isRiskChoiceAllowed } from '@/utils/toolRisk';

interface ServerToolRiskFieldProps {
  value: ToolRiskLevel;
  defaultValue: ToolRiskLevel;
  // Both change together: lowering the cap pulls the default down with it.
  onChange: (value: ToolRiskLevel, defaultValue: ToolRiskLevel) => void;
}

// The highest tool risk level non-admin users can use on this server (`external` is no cap) and
// the level users start at until they choose one. Shown to administrators under Workspace Mode.
const ServerToolRiskField = ({ value, defaultValue, onChange }: ServerToolRiskFieldProps) => {
  const { t } = useTranslation();
  return (
    <div className="rounded border border-gray-200 dark:border-gray-700 p-3 space-y-3">
      <div>
        <label
          htmlFor="max-tool-risk"
          className="block text-sm font-medium text-[var(--hub-ink-2)]"
        >
          {t('server.maxToolRisk.title')}
        </label>
        <p className="text-xs text-gray-500 mt-1 mb-3">{t('server.maxToolRisk.description')}</p>
        <select
          id="max-tool-risk"
          value={value}
          onChange={(event) => {
            const cap = event.target.value as ToolRiskLevel;
            onChange(cap, clampDefaultToCap(defaultValue, cap));
          }}
          className="w-full py-2 px-3 form-input text-sm"
        >
          {TOOL_RISK_LEVELS.map((level) => (
            <option key={level} value={level}>
              {t(`server.maxToolRisk.${level}`)}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label
          htmlFor="default-user-risk"
          className="block text-sm font-medium text-[var(--hub-ink-2)]"
        >
          {t('server.defaultUserRisk.title')}
        </label>
        <p className="text-xs text-gray-500 mt-1 mb-3">{t('server.defaultUserRisk.description')}</p>
        <select
          id="default-user-risk"
          value={defaultValue}
          onChange={(event) => onChange(value, event.target.value as ToolRiskLevel)}
          className="w-full py-2 px-3 form-input text-sm"
        >
          {TOOL_RISK_LEVELS.map((level) => (
            <option key={level} value={level} disabled={!isRiskChoiceAllowed(level, value)}>
              {t(`server.defaultUserRisk.${level}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};

export default ServerToolRiskField;
