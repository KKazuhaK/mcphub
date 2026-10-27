import {
  assertMaintenanceEndsInFuture,
  diffPausedUsers,
  getActiveMaintenance,
  isPausedForUser,
  normalizeMaintenance,
  normalizePausedUsers,
} from '../../src/utils/serverMaintenance.js';
import { normalizeServerConfigForPersistence } from '../../src/utils/serverConfigPersistence.js';
import { ServerConfigValidationError } from '../../src/utils/serverConfigValidation.js';

const UNTIL = '2026-10-27T18:00:00.000Z';
const at = (iso: string) => Date.parse(iso);

describe('normalizePausedUsers', () => {
  it('trims, drops blanks and deduplicates, and treats none as absent', () => {
    expect(normalizePausedUsers([' bob ', 'bob', '', 'carol'])).toEqual(['bob', 'carol']);
    expect(normalizePausedUsers([])).toBeUndefined();
    expect(normalizePausedUsers(null)).toBeUndefined();
    expect(normalizePausedUsers(undefined)).toBeUndefined();
  });

  it('rejects anything but an array of strings, and more than 1000 distinct users', () => {
    expect(() => normalizePausedUsers('bob')).toThrow(ServerConfigValidationError);
    expect(() => normalizePausedUsers([1])).toThrow(ServerConfigValidationError);
    expect(() => normalizePausedUsers(['x'.repeat(256)])).toThrow(ServerConfigValidationError);
    const many = Array.from({ length: 1001 }, (_, index) => `u${index}`);
    expect(() => normalizePausedUsers(many)).toThrow(/at most 1000/);
    expect(normalizePausedUsers([...many.slice(0, 1000), ...many.slice(0, 1000)])).toHaveLength(
      1000,
    );
  });
});

describe('normalizeMaintenance', () => {
  it('normalizes the end time to UTC and trims the message', () => {
    expect(
      normalizeMaintenance({ until: '2026-10-27T20:00:00+02:00', message: ' Back soon ' }),
    ).toEqual({
      until: UNTIL,
      message: 'Back soon',
    });
    expect(normalizeMaintenance({ until: '2026-10-27T18:00Z' })).toEqual({ until: UNTIL });
    expect(normalizeMaintenance({ until: '2026-10-27T18:00:00.5-05:30' })?.until).toBe(
      '2026-10-27T23:30:00.500Z',
    );
  });

  it('keeps an empty window and drops blank fields; null clears', () => {
    expect(normalizeMaintenance({})).toEqual({});
    expect(normalizeMaintenance({ until: '', message: '  ' })).toEqual({});
    expect(normalizeMaintenance(null)).toBeUndefined();
    expect(normalizeMaintenance(undefined)).toBeUndefined();
  });

  it.each([
    ['not a string', { until: 5 }],
    ['not a date', { until: 'tomorrow' }],
    ['a date Date.parse would accept but ISO 8601 does not', { until: 'Oct 27 2026' }],
    ['a date without a time', { until: '2026-10-27' }],
    ['a date-time without a zone', { until: '2026-10-27T18:00:00' }],
    ['February 30th', { until: '2026-02-30T10:00:00Z' }],
    ['February 29th in a common year', { until: '2027-02-29T10:00:00Z' }],
    ['hour 24', { until: '2026-10-27T24:00:00Z' }],
    ['an offset beyond 23:59', { until: '2026-10-27T10:00:00+24:00' }],
    ['a lowercase separator', { until: '2026-10-27t18:00:00z' }],
    ['a bidi override in the message', { message: 'abc\u202Edef' }],
    ['a zero-width space in the message', { message: 'a\u200Bb' }],
    ['a line separator in the message', { message: 'a\u2028b' }],
    ['a paragraph separator in the message', { message: 'a\u2029b' }],
    ['a byte order mark in the message', { message: 'a\uFEFFb' }],
    ['an impossible date', { until: '2026-13-45T00:00:00Z' }],
    ['a non-string message', { message: 1 }],
    ['a message over 200 characters', { message: 'x'.repeat(201) }],
    ['a message with a newline', { message: 'a\nb' }],
    ['a message with a tab', { message: 'a\tb' }],
    ['a message with a C1 control character', { message: 'a\u0085b' }],
    ['an array', []],
    ['a string', 'now'],
  ])('rejects %s', (_name, value) => {
    expect(() => normalizeMaintenance(value)).toThrow(ServerConfigValidationError);
  });

  it('accepts a message of exactly 200 characters', () => {
    expect(normalizeMaintenance({ message: 'x'.repeat(200) })?.message).toHaveLength(200);
  });
});

describe('stored values are not re-validated', () => {
  it('treats a malformed stored window as inactive, with a warning', () => {
    for (const maintenance of [{ until: 'garbage' }, { message: 7 }, 'now', [], { until: 5 }]) {
      expect(
        getActiveMaintenance({ maintenance: maintenance as never }, at(UNTIL)),
      ).toBeUndefined();
    }
  });

  it('ignores a stored pause list that is not an array', () => {
    expect(isPausedForUser({ pausedUsers: 'bob' as never }, 'bob')).toBe(false);
    expect(isPausedForUser({ pausedUsers: [3, 'bob'] as never }, 'bob')).toBe(true);
    expect(isPausedForUser({ pausedUsers: [3, 'bob'] as never }, '3')).toBe(false);
  });
});

describe('stored messages are sanitized at read time', () => {
  it('strips control, format and separator characters and truncates to 200', () => {
    const active = getActiveMaintenance(
      { maintenance: { message: 'a\n\u202Eb\u200Bc\u2028d\u2029e\u0007f' } },
      at(UNTIL),
    );
    expect(active?.message).toBe('abcdef');

    const long = getActiveMaintenance({ maintenance: { message: 'x'.repeat(500) } }, at(UNTIL));
    expect(long?.message).toHaveLength(200);
  });

  it('drops a message that sanitizes to nothing and keeps the window', () => {
    expect(getActiveMaintenance({ maintenance: { message: '\u200B\n' } }, at(UNTIL))).toEqual({});
    expect(
      getActiveMaintenance({ maintenance: { until: UNTIL, message: 'ok' } }, at(UNTIL) - 1),
    ).toEqual({ until: UNTIL, message: 'ok' });
  });

  it('ignores a stored pause list that is not an array when diffing', () => {
    expect(diffPausedUsers('abc' as never, ['x'])).toEqual(['x']);
  });
});

describe('assertMaintenanceEndsInFuture', () => {
  it('rejects a new end time that is not ahead, and accepts the stored one back', () => {
    expect(() => assertMaintenanceEndsInFuture({ until: UNTIL }, undefined, at(UNTIL))).toThrow(
      /in the future/,
    );
    expect(() =>
      assertMaintenanceEndsInFuture({ until: UNTIL }, undefined, at(UNTIL) - 1),
    ).not.toThrow();
    expect(() =>
      assertMaintenanceEndsInFuture({ until: UNTIL }, { until: UNTIL }, at(UNTIL) + 1000),
    ).not.toThrow();
    expect(() => assertMaintenanceEndsInFuture({}, undefined)).not.toThrow();
    expect(() => assertMaintenanceEndsInFuture(undefined, undefined)).not.toThrow();
  });
});

describe('getActiveMaintenance', () => {
  it('is in force without an end time, and until the end time passes', () => {
    expect(getActiveMaintenance({ maintenance: {} }, at(UNTIL))).toEqual({});
    expect(getActiveMaintenance({ maintenance: { until: UNTIL } }, at(UNTIL) - 1)).toEqual({
      until: UNTIL,
    });
    expect(getActiveMaintenance({ maintenance: { until: UNTIL } }, at(UNTIL))).toBeUndefined();
    expect(getActiveMaintenance({ maintenance: { until: UNTIL } }, at(UNTIL) + 1)).toBeUndefined();
  });

  it('is absent when nothing is set', () => {
    expect(getActiveMaintenance(undefined)).toBeUndefined();
    expect(getActiveMaintenance({})).toBeUndefined();
  });

  it('reads the clock when none is injected', () => {
    jest.useFakeTimers({ now: at(UNTIL) - 1000 });
    try {
      expect(getActiveMaintenance({ maintenance: { until: UNTIL } })).toBeDefined();
      jest.setSystemTime(at(UNTIL) + 1000);
      expect(getActiveMaintenance({ maintenance: { until: UNTIL } })).toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('isPausedForUser and diffPausedUsers', () => {
  it('matches exact usernames only', () => {
    expect(isPausedForUser({ pausedUsers: ['bob'] }, 'bob')).toBe(true);
    expect(isPausedForUser({ pausedUsers: ['bob'] }, 'Bob')).toBe(false);
    expect(isPausedForUser({ pausedUsers: ['bob'] }, undefined)).toBe(false);
    expect(isPausedForUser({}, 'bob')).toBe(false);
  });

  it('reports users added or removed', () => {
    expect(diffPausedUsers(['a', 'b'], ['b', 'c']).sort()).toEqual(['a', 'c']);
    expect(diffPausedUsers(undefined, ['a'])).toEqual(['a']);
    expect(diffPausedUsers(['a'], ['a'])).toEqual([]);
  });
});

describe('normalizeServerConfigForPersistence', () => {
  const base = { type: 'sse' as const, url: 'https://example.com/sse' };

  it('leaves the keys out when the config does not carry them, so an update keeps the stored values', () => {
    const normalized = normalizeServerConfigForPersistence(base);
    expect(normalized).not.toHaveProperty('pausedUsers');
    expect(normalized).not.toHaveProperty('maintenance');
  });

  it('emits an explicit undefined for null or empty, so an update clears the stored values', () => {
    const normalized = normalizeServerConfigForPersistence({
      ...base,
      pausedUsers: [],
      maintenance: null as never,
    });
    expect(normalized).toHaveProperty('pausedUsers', undefined);
    expect(normalized).toHaveProperty('maintenance', undefined);
  });

  it('validates both fields', () => {
    expect(() =>
      normalizeServerConfigForPersistence({ ...base, maintenance: { until: 'soon' } }),
    ).toThrow(ServerConfigValidationError);
    expect(() =>
      normalizeServerConfigForPersistence({ ...base, pausedUsers: 'bob' as never }),
    ).toThrow(ServerConfigValidationError);
  });
});
