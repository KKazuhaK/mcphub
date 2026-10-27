import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ServerFormData } from '@/types';
import { apiGet } from '../utils/fetchInterceptor';
import { filterShareUsers, getSelectableShareUsers } from '../utils/shareUserSelection.js';

const MESSAGE_LIMIT = 200;

// An ISO instant as the local `datetime-local` value, and back.
const toLocalInput = (iso?: string): string => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromLocalInput = (value: string): string | undefined => {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? date.toISOString() : undefined;
};

interface ServerAvailabilityFieldsProps {
  serverName?: string;
  maintenance: NonNullable<ServerFormData['maintenance']>;
  pausedUsers: string[];
  onMaintenanceChange: (maintenance: NonNullable<ServerFormData['maintenance']>) => void;
  onPausedUsersChange: (pausedUsers: string[]) => void;
}

// Admin-only controls for Workspace Mode: a maintenance window and a per-user pause list.
const ServerAvailabilityFields = ({
  serverName,
  maintenance,
  pausedUsers,
  onMaintenanceChange,
  onPausedUsersChange,
}: ServerAvailabilityFieldsProps) => {
  const { t } = useTranslation();
  const [candidates, setCandidates] = useState<string[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!serverName) return;
    let cancelled = false;
    void apiGet<{ success: boolean; data?: string[] }>(
      `/servers/${encodeURIComponent(serverName)}/share-candidates`,
    )
      .then((response) => {
        if (!cancelled && response.success && Array.isArray(response.data)) {
          setCandidates(response.data);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [serverName]);

  const users = filterShareUsers(getSelectableShareUsers(pausedUsers, candidates), search);
  const paused = new Set(pausedUsers);
  const toggleUser = (username: string) =>
    onPausedUsersChange(
      paused.has(username)
        ? pausedUsers.filter((user) => user !== username)
        : [...pausedUsers, username],
    );

  return (
    <div className="space-y-4" data-testid="server-availability-fields">
      <div className="rounded border border-gray-200 dark:border-gray-700 p-3">
        <label className="flex items-center gap-2 text-sm font-medium text-[var(--hub-ink-2)]">
          <input
            type="checkbox"
            checked={maintenance.enabled}
            onChange={(event) =>
              onMaintenanceChange({ ...maintenance, enabled: event.target.checked })
            }
          />
          {t('server.maintenance.title', 'Maintenance')}
        </label>
        <p className="text-xs text-gray-500 mt-1 mb-3">
          {t(
            'server.maintenance.description',
            'Users who selected this server see it as under maintenance and cannot use it until the end time passes or you turn this off. The connection stays up. Applies only under Workspace Mode.',
          )}
        </p>
        {maintenance.enabled && (
          <div className="space-y-3">
            <div>
              <label
                htmlFor="maintenance-until"
                className="block text-xs font-medium text-[var(--hub-ink-2)] mb-1"
              >
                {t('server.maintenance.until', 'Ends at (optional)')}
              </label>
              <input
                id="maintenance-until"
                type="datetime-local"
                value={toLocalInput(maintenance.until)}
                onChange={(event) =>
                  onMaintenanceChange({
                    ...maintenance,
                    until: fromLocalInput(event.target.value),
                  })
                }
                className="w-full py-2 px-3 form-input text-sm"
              />
            </div>
            <div>
              <label
                htmlFor="maintenance-message"
                className="block text-xs font-medium text-[var(--hub-ink-2)] mb-1"
              >
                {t('server.maintenance.message', 'Message for users (optional)')}
              </label>
              <input
                id="maintenance-message"
                type="text"
                maxLength={MESSAGE_LIMIT}
                value={maintenance.message}
                onChange={(event) =>
                  onMaintenanceChange({ ...maintenance, message: event.target.value })
                }
                className="w-full py-2 px-3 form-input text-sm"
              />
              <p className="text-xs text-gray-500 mt-1">
                {maintenance.message.length}/{MESSAGE_LIMIT}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="rounded border border-gray-200 dark:border-gray-700 p-3">
        <div className="text-sm font-medium text-[var(--hub-ink-2)]">
          {t('server.pauseForUsers.title', 'Pause for users')}
        </div>
        <p className="text-xs text-gray-500 mt-1 mb-3">
          {t(
            'server.pauseForUsers.description',
            'The server stays available to everyone else. Applies only under Workspace Mode.',
          )}
        </p>
        {!serverName ? (
          <p className="text-sm text-gray-500">
            {t('server.pauseForUsers.afterCreate', 'Save the server before selecting users.')}
          </p>
        ) : (
          <>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('server.shareUserSearchPlaceholder', 'Search usernames...')}
              aria-label={t('server.shareUserSearchLabel', 'Search users')}
              className="w-full py-2 px-3 form-input text-sm mb-3"
            />
            {users.length === 0 ? (
              <p className="text-sm text-gray-500">
                {t('server.noMatchingShareUsers', 'No users match your search.')}
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {users.map((username) => (
                  <label
                    key={username}
                    className="flex items-center gap-2 rounded border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm text-[var(--hub-ink-2)]"
                  >
                    <input
                      type="checkbox"
                      checked={paused.has(username)}
                      onChange={() => toggleUser(username)}
                    />
                    <span>{username}</span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default ServerAvailabilityFields;
