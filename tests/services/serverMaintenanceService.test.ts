import { jest } from '@jest/globals';
import type { ServerAvailabilityState } from '../../src/services/serverMaintenanceService.js';

let workspaceEnabled = true;
const sessionUsers = ['alice', 'bob', 'carol'];
const selections: Record<string, string[]> = {
  alice: ['alpha'],
  bob: ['alpha', 'beta'],
  carol: ['beta'],
};
const mockNotifyUserListsChanged = jest.fn<(username: string) => void>();

jest.mock('../../src/services/userServerSelectionService.js', () => ({
  isWorkspaceEnabled: jest.fn(() => workspaceEnabled),
  getSelectedServerNames: jest.fn(async (username: string) => new Set(selections[username] ?? [])),
}));

jest.mock('../../src/services/mcpService.js', () => ({
  notifyUserListsChanged: (username: string) => mockNotifyUserListsChanged(username),
  listSessionUsernames: () => sessionUsers,
}));

import {
  clearMaintenanceExpiry,
  handleServerAvailabilityChange,
  scheduleMaintenanceExpiry,
} from '../../src/services/serverMaintenanceService.js';

const NOW = Date.parse('2026-10-27T12:00:00.000Z');
const IN_ONE_HOUR = new Date(NOW + 3_600_000).toISOString();
const notified = () => mockNotifyUserListsChanged.mock.calls.map(([username]) => username).sort();
// Lets the async notification chain settle under fake timers.
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('serverMaintenanceService', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    jest.clearAllMocks();
    workspaceEnabled = true;
  });

  afterEach(() => {
    for (const name of ['alpha', 'beta', 'renamed']) clearMaintenanceExpiry(name);
    jest.useRealTimers();
  });

  describe('handleServerAvailabilityChange', () => {
    it('notifies only the users whose pause changed', async () => {
      await handleServerAvailabilityChange(
        'alpha',
        { pausedUsers: ['alice'] },
        { pausedUsers: ['alice', 'carol'] },
      );
      expect(notified()).toEqual(['carol']);

      mockNotifyUserListsChanged.mockClear();
      await handleServerAvailabilityChange('alpha', { pausedUsers: ['alice', 'carol'] }, {});
      expect(notified()).toEqual(['alice', 'carol']);
    });

    it('notifies every open session when maintenance starts and ends, selected or not', async () => {
      await handleServerAvailabilityChange('alpha', {}, { maintenance: {} });
      expect(notified()).toEqual(['alice', 'bob', 'carol']);

      mockNotifyUserListsChanged.mockClear();
      await handleServerAvailabilityChange('beta', { maintenance: {} }, {});
      expect(notified()).toEqual(['alice', 'bob', 'carol']);
    });

    it('stays quiet when only the message or end time changed, or nothing did', async () => {
      await handleServerAvailabilityChange(
        'alpha',
        { maintenance: { message: 'a' } },
        { maintenance: { message: 'b', until: IN_ONE_HOUR } },
      );
      await handleServerAvailabilityChange(
        'alpha',
        { pausedUsers: ['alice'] },
        { pausedUsers: ['alice'] },
      );
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
    });

    it('treats an already expired window as not in maintenance', async () => {
      const expired = { maintenance: { until: new Date(NOW - 1000).toISOString() } };
      await handleServerAvailabilityChange('alpha', {}, expired);
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
    });

    it('does nothing when the workspace setting is off', async () => {
      workspaceEnabled = false;
      await handleServerAvailabilityChange('alpha', { pausedUsers: ['bob'] }, { maintenance: {} });
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
    });
  });

  describe('expiry timer', () => {
    const withEnd = (until: string): ServerAvailabilityState => ({ maintenance: { until } });

    it('notifies every open session once the window ends', async () => {
      scheduleMaintenanceExpiry('alpha', withEnd(IN_ONE_HOUR));

      jest.advanceTimersByTime(3_599_000);
      await settle();
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();

      jest.advanceTimersByTime(2000);
      await settle();
      expect(notified()).toEqual(['alice', 'bob', 'carol']);

      // One shot: nothing fires again.
      mockNotifyUserListsChanged.mockClear();
      jest.advanceTimersByTime(7_200_000);
      await settle();
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
    });

    it('is armed when the change is applied and replaced when the end time moves', async () => {
      await handleServerAvailabilityChange('alpha', {}, withEnd(IN_ONE_HOUR));
      mockNotifyUserListsChanged.mockClear();

      const later = new Date(NOW + 7_200_000).toISOString();
      await handleServerAvailabilityChange('alpha', withEnd(IN_ONE_HOUR), withEnd(later));

      jest.advanceTimersByTime(3_700_000);
      await settle();
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
      jest.advanceTimersByTime(3_600_000);
      await settle();
      expect(notified()).toEqual(['alice', 'bob', 'carol']);
    });

    it('is cleared when maintenance is switched off, and on delete or rename', async () => {
      scheduleMaintenanceExpiry('alpha', withEnd(IN_ONE_HOUR));
      await handleServerAvailabilityChange('alpha', withEnd(IN_ONE_HOUR), {});
      mockNotifyUserListsChanged.mockClear();

      scheduleMaintenanceExpiry('beta', withEnd(IN_ONE_HOUR));
      clearMaintenanceExpiry('beta');

      jest.advanceTimersByTime(7_200_000);
      await settle();
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not arm anything without an end time or for a window already over', () => {
      scheduleMaintenanceExpiry('alpha', { maintenance: {} });
      scheduleMaintenanceExpiry('beta', withEnd(new Date(NOW - 1).toISOString()));
      expect(jest.getTimerCount()).toBe(0);
    });

    it('keeps one timer per server', () => {
      scheduleMaintenanceExpiry('alpha', withEnd(IN_ONE_HOUR));
      scheduleMaintenanceExpiry('alpha', withEnd(IN_ONE_HOUR));
      expect(jest.getTimerCount()).toBe(1);
    });

    it('waits out an end time beyond the timer limit by re-arming', async () => {
      const farAway = new Date(NOW + 40 * 24 * 3_600_000).toISOString();
      scheduleMaintenanceExpiry('alpha', withEnd(farAway));

      jest.advanceTimersByTime(2 ** 31 - 1);
      await settle();
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(1);

      jest.advanceTimersByTime(40 * 24 * 3_600_000 - (2 ** 31 - 1) + 1000);
      await settle();
      expect(notified()).toEqual(['alice', 'bob', 'carol']);
    });

    it('notifies nobody if the setting was turned off before it fired', async () => {
      scheduleMaintenanceExpiry('alpha', withEnd(IN_ONE_HOUR));
      workspaceEnabled = false;

      jest.advanceTimersByTime(3_700_000);
      await settle();
      expect(mockNotifyUserListsChanged).not.toHaveBeenCalled();
    });
  });
});
