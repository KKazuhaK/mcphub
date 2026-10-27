import type { ToolRiskLevel, WorkspaceServer } from '../../frontend/src/types';
import {
  TOOL_RISK_LEVELS,
  applyRiskCeiling,
  clampDefaultToCap,
  changeRiskCeiling,
  countHiddenByCeiling,
  countHiddenTools,
  countWithinCeiling,
  isRiskChoiceAllowed,
  isToolRiskLevel,
  overrideChoices,
  riskRank,
} from '../../frontend/src/utils/toolRisk';
import { countExposedTools } from '../../frontend/src/utils/workspace';

const counts = { read: 4, write: 3, external: 2 };

const server = (name: string, extra: Partial<WorkspaceServer> = {}): WorkspaceServer => ({
  name,
  selected: true,
  enabled: true,
  toolCount: 4,
  riskCeiling: 'read',
  riskCeilingIsDefault: false,
  riskCounts: counts,
  maxAllowedRisk: 'external',
  annotationsTrusted: true,
  requiresPersonalCredential: false,
  credentialConfigured: true,
  status: { code: 'available', message: 'ok', action: null },
  ...extra,
});

describe('levels', () => {
  it('are ordered read < write < external', () => {
    expect(TOOL_RISK_LEVELS).toEqual(['read', 'write', 'external']);
    expect(riskRank('read')).toBeLessThan(riskRank('write'));
    expect(riskRank('write')).toBeLessThan(riskRank('external'));
  });

  it('are recognized exactly', () => {
    expect(TOOL_RISK_LEVELS.every(isToolRiskLevel)).toBe(true);
    for (const value of ['', 'Read', 'admin', null, undefined, 2]) {
      expect(isToolRiskLevel(value)).toBe(false);
    }
  });
});

describe('the choices a user is offered', () => {
  it('disables options above the administrator’s cap', () => {
    expect(TOOL_RISK_LEVELS.map((level) => isRiskChoiceAllowed(level, 'external'))).toEqual([
      true,
      true,
      true,
    ]);
    expect(TOOL_RISK_LEVELS.map((level) => isRiskChoiceAllowed(level, 'write'))).toEqual([
      true,
      true,
      false,
    ]);
    expect(TOOL_RISK_LEVELS.map((level) => isRiskChoiceAllowed(level, 'read'))).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe('tool counts', () => {
  it.each([
    ['read', 4, 5],
    ['write', 7, 2],
    ['external', 9, 0],
  ] as Array<[ToolRiskLevel, number, number]>)(
    'count only tools within the %s ceiling',
    (ceiling, within, hidden) => {
      expect(countWithinCeiling(counts, ceiling)).toBe(within);
      expect(countHiddenByCeiling(counts, ceiling)).toBe(hidden);
    },
  );

  it('tolerate missing levels', () => {
    expect(countWithinCeiling({ read: 2 } as never, 'external')).toBe(2);
  });

  it('add up the hidden tools of selected services only', () => {
    const servers = [
      server('a'),
      server('b', { riskCeiling: 'write' }),
      server('c', { selected: false }),
    ];
    expect(countHiddenTools(servers)).toBe(5 + 2);
    expect(countHiddenTools([])).toBe(0);
  });

  it('feed the tool-count indicator with the tools within the ceiling', () => {
    const next = applyRiskCeiling([server('a')], 'a', 'external');
    expect(next[0].toolCount).toBe(9);
    expect(countExposedTools(next)).toBe(9);
    expect(countExposedTools(applyRiskCeiling(next, 'a', 'read'))).toBe(4);
  });
});

describe('applyRiskCeiling', () => {
  it('changes only the named service and does not mutate', () => {
    const servers = [server('a'), server('b')];
    const next = applyRiskCeiling(servers, 'b', 'write');
    expect(next.map((entry) => entry.riskCeiling)).toEqual(['read', 'write']);
    expect(next[1].toolCount).toBe(7);
    expect(next[0]).toBe(servers[0]);
    expect(servers[1].riskCeiling).toBe('read');
  });
});

describe('changeRiskCeiling', () => {
  it('updates the UI first, then saves', async () => {
    let servers = [server('a')];
    const order: string[] = [];
    const saved = await changeRiskCeiling(servers[0], 'write', {
      update: (updater) => {
        servers = updater(servers);
        order.push(`ui:${servers[0].riskCeiling}`);
      },
      save: async (name, level) => {
        order.push(`save:${name}:${level}`);
      },
    });
    expect(saved).toBe(true);
    expect(order).toEqual(['ui:write', 'save:a:write']);
  });

  it('restores that service’s previous choice when saving fails', async () => {
    let servers = [server('a'), server('b', { riskCeiling: 'write', toolCount: 7 })];
    const saved = await changeRiskCeiling(servers[0], 'external', {
      update: (updater) => {
        servers = updater(servers);
      },
      save: async () => {
        throw new Error('nope');
      },
    });
    expect(saved).toBe(false);
    expect(servers[0].riskCeiling).toBe('read');
    expect(servers[0].toolCount).toBe(4);
    expect(servers[1].riskCeiling).toBe('write');
  });

  it('does nothing for the level already chosen', async () => {
    const save = jest.fn();
    const update = jest.fn();
    expect(await changeRiskCeiling(server('a'), 'read', { save, update })).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('administrator overrides', () => {
  it('can only raise a tool: the choices start at its computed level', () => {
    expect(overrideChoices('read')).toEqual(['read', 'write', 'external']);
    expect(overrideChoices('write')).toEqual(['write', 'external']);
    expect(overrideChoices('external')).toEqual(['external']);
  });
});

describe('services whose tools are not known yet', () => {
  const unknown = server('personal', { toolCount: null, riskCounts: null });

  it('count as zero in the helpers and add nothing to the hidden-tools banner', () => {
    expect(countWithinCeiling(null, 'external')).toBe(0);
    expect(countHiddenByCeiling(null, 'read')).toBe(0);
    expect(countHiddenTools([unknown])).toBe(0);
    expect(countHiddenTools([unknown, server('a')])).toBe(5);
    expect(countExposedTools([unknown, server('a')])).toBe(4);
  });

  it('stay unknown when a ceiling is chosen', () => {
    const [next] = applyRiskCeiling([unknown], 'personal', 'write');
    expect(next.riskCeiling).toBe('write');
    expect(next.toolCount).toBeNull();
    expect(next.riskCounts).toBeNull();
  });
});

describe('the administrator’s default', () => {
  it('turns into a recorded choice when the user picks any level, even the default one', async () => {
    const save = jest.fn(async () => undefined);
    let servers = [server('a', { riskCeilingIsDefault: true })];
    expect(
      await changeRiskCeiling(servers[0], 'read', {
        save,
        update: (updater) => {
          servers = updater(servers);
        },
      }),
    ).toBe(true);
    expect(save).toHaveBeenCalledWith('a', 'read');
    expect(servers[0].riskCeilingIsDefault).toBe(false);
  });

  it('is restored with the level when saving fails', async () => {
    let servers = [server('a', { riskCeilingIsDefault: true })];
    await changeRiskCeiling(servers[0], 'write', {
      save: async () => {
        throw new Error('nope');
      },
      update: (updater) => {
        servers = updater(servers);
      },
    });
    expect(servers[0]).toMatchObject({ riskCeiling: 'read', riskCeilingIsDefault: true });
  });

  it('is pulled down with the cap, never up', () => {
    expect(clampDefaultToCap('write', 'read')).toBe('read');
    expect(clampDefaultToCap('external', 'write')).toBe('write');
    expect(clampDefaultToCap('read', 'external')).toBe('read');
    expect(clampDefaultToCap('write', 'write')).toBe('write');
  });
});
