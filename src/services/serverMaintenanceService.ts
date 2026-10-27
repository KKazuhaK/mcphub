import type { ServerConfig } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { diffPausedUsers, getActiveMaintenance } from '../utils/serverMaintenance.js';
import { isWorkspaceEnabled } from './userServerSelectionService.js';

// Admin availability state of one server: who it is paused for and its maintenance window.
export type ServerAvailabilityState = Pick<ServerConfig, 'pausedUsers' | 'maintenance'>;

// setTimeout stores its delay in 32 bits; a longer wait re-arms itself.
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

// One timer per server, firing when its maintenance window ends.
const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

const loadMcpService = () => import('./mcpService.js');

// Tells the live sessions of the given users that their lists changed.
const notifyUsers = async (usernames: string[]): Promise<void> => {
  if (!usernames.length || !isWorkspaceEnabled()) return;
  try {
    const { notifyUserListsChanged } = await loadMcpService();
    for (const username of new Set(usernames)) notifyUserListsChanged(username);
  } catch (error) {
    logger.warn('Failed to notify users of a server availability change', { error });
  }
};

// Maintenance applies on every route, so every user with an open MCP session may be looking
// at the server's tools, whether or not they selected it.
const notifySessionUsers = async (serverName: string): Promise<void> => {
  if (!isWorkspaceEnabled()) return;
  try {
    const { listSessionUsernames } = await loadMcpService();
    await notifyUsers(listSessionUsernames());
  } catch (error) {
    logger.warn('Failed to notify users of a maintenance change', { serverName, error });
  }
};

export const clearMaintenanceExpiry = (serverName: string): void => {
  const timer = expiryTimers.get(serverName);
  if (timer === undefined) return;
  clearTimeout(timer);
  expiryTimers.delete(serverName);
};

// Arms the single timer that tells users a maintenance window ended. No write is needed for
// the state itself: it is computed from `until` whenever it is read.
export const scheduleMaintenanceExpiry = (
  serverName: string,
  config: ServerAvailabilityState | undefined,
  now: number = Date.now(),
): void => {
  clearMaintenanceExpiry(serverName);
  const until = getActiveMaintenance(config, now)?.until;
  if (!until) return;
  const end = Date.parse(until);
  const timer = setTimeout(
    () => {
      expiryTimers.delete(serverName);
      if (Date.now() < end) {
        scheduleMaintenanceExpiry(serverName, config);
        return;
      }
      void notifySessionUsers(serverName);
    },
    Math.min(Math.max(end - now, 0), MAX_TIMER_DELAY_MS),
  );
  timer.unref?.();
  expiryTimers.set(serverName, timer);
};

export const scheduleAllMaintenanceExpiries = (
  servers: Array<{ name: string } & ServerAvailabilityState>,
): void => {
  for (const server of servers) scheduleMaintenanceExpiry(server.name, server);
};

// A new tool risk cap or override changes what every non-admin requester may list and call,
// whether or not they selected the server, so every open session is told.
export const handleToolRiskChange = async (serverName: string): Promise<void> => {
  await notifySessionUsers(serverName);
};

// Applies a change of a server's pause list or maintenance window: users whose paused state
// flipped are notified, and when maintenance started or ended, so is every user with an open session. Editing only the message or end time leaves every list as it was.
export const handleServerAvailabilityChange = async (
  serverName: string,
  before: ServerAvailabilityState | undefined,
  after: ServerAvailabilityState | undefined,
  now: number = Date.now(),
): Promise<void> => {
  scheduleMaintenanceExpiry(serverName, after, now);
  await notifyUsers(diffPausedUsers(before?.pausedUsers, after?.pausedUsers));
  if (Boolean(getActiveMaintenance(before, now)) !== Boolean(getActiveMaintenance(after, now))) {
    await notifySessionUsers(serverName);
  }
};
