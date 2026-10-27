import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from './ui/ConfirmDialog';

export const parseRetentionDays = (text: string): number | null | 'invalid' => {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!/^\d+$/.test(trimmed)) return 'invalid';
  const days = Number(trimmed);
  return days >= 1 && days <= 3650 ? days : 'invalid';
};

interface Props {
  /** Days activity is kept; null keeps it forever. */
  value: number | null;
  /** Days of history users see (`workspace.activityRetentionDays`); activity is never purged inside it. */
  viewWindowDays?: number;
  disabled?: boolean;
  onSave: (days: number | null) => Promise<boolean>;
}

// Administrator-wide: older activity is permanently deleted, so saving a number asks first.
const ActivityRetentionSetting: React.FC<Props> = ({
  value,
  viewWindowDays = 90,
  disabled,
  onSave,
}) => {
  const { t } = useTranslation();
  const [text, setText] = useState(value === null ? '' : String(value));
  const [confirming, setConfirming] = useState<number | null>(null);

  useEffect(() => {
    setText(value === null ? '' : String(value));
  }, [value]);

  const parsed = parseRetentionDays(text);
  const changed = parsed !== 'invalid' && parsed !== value;

  const save = () => {
    if (parsed === 'invalid' || !changed) return;
    if (parsed === null) void onSave(null);
    else setConfirming(parsed);
  };

  return (
    <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-md">
      <div className="mb-2">
        <h3 className="font-medium text-gray-700">{t('settings.activityRetention')}</h3>
        <p className="text-sm text-gray-500">{t('settings.activityRetentionDescription')}</p>
        <p className="text-sm mt-1" style={{ color: 'var(--hub-warn)' }} role="note">
          {t('settings.activityRetentionWarning')}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="text"
          inputMode="numeric"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t('settings.activityRetentionPlaceholder')}
          aria-label={t('settings.activityRetention')}
          aria-invalid={parsed === 'invalid'}
          className="flex-1 mt-1 block w-full py-2 px-3 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm form-input"
          disabled={disabled}
        />
        <button
          type="button"
          onClick={save}
          disabled={disabled || !changed}
          className="hub-btn primary"
        >
          {t('common.save')}
        </button>
      </div>
      {parsed === 'invalid' && (
        <p className="text-sm mt-1" style={{ color: 'var(--hub-err)' }} role="alert">
          {t('settings.activityRetentionInvalid')}
        </p>
      )}
      <ConfirmDialog
        isOpen={confirming !== null}
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          const days = confirming;
          setConfirming(null);
          if (days !== null) void onSave(days);
        }}
        variant="danger"
        title={t('settings.activityRetentionConfirmTitle')}
        message={t('settings.activityRetentionConfirmMessage', {
          days: Math.max(confirming ?? 0, viewWindowDays),
          entered: confirming ?? 0,
        })}
        confirmText={t('settings.activityRetentionConfirm')}
      />
    </div>
  );
};

export default ActivityRetentionSetting;
