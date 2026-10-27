import {
  assertDefaultWithinCap,
  assertOverridesOnlyRaise,
  getDefaultUserRisk,
  normalizeDefaultUserRisk,
  classifyToolRisk,
  getEffectiveToolRisk,
  getMaxToolRisk,
  getToolRiskInfo,
  isToolRiskLevel,
  maxRisk,
  minRisk,
  normalizeMaxToolRisk,
  normalizeToolRiskOverrides,
  riskRank,
  toolRiskChanged,
} from '../../src/utils/toolRisk.js';
import { ServerConfigValidationError } from '../../src/utils/serverConfigValidation.js';

jest.mock('../../src/config/index.js', () => ({
  getNameSeparator: () => '::',
  default: {},
}));

describe('classifyToolRisk', () => {
  // Every combination of the two hints, absent / true / false.
  const hint = [undefined, true, false] as const;
  const expected = (readOnly?: boolean, openWorld?: boolean) =>
    readOnly === true ? 'read' : openWorld === false ? 'write' : 'external';

  describe.each(hint)('readOnlyHint %s', (readOnlyHint) => {
    it.each(hint)('openWorldHint %s', (openWorldHint) => {
      const annotations: Record<string, unknown> = {};
      if (readOnlyHint !== undefined) annotations.readOnlyHint = readOnlyHint;
      if (openWorldHint !== undefined) annotations.openWorldHint = openWorldHint;
      expect(classifyToolRisk({ annotations })).toBe(expected(readOnlyHint, openWorldHint));
    });
  });

  it.each([
    ['no annotations', {}],
    ['an undefined tool', undefined],
    ['null annotations', { annotations: null }],
    ['a string for annotations', { annotations: 'readOnlyHint' }],
    ['unrelated annotations', { annotations: { title: 'x', destructiveHint: true } }],
    [
      'hints that are not booleans',
      { annotations: { readOnlyHint: 'true', openWorldHint: 'false' } },
    ],
  ])('treats %s as external', (_label, tool) => {
    expect(classifyToolRisk(tool as never)).toBe('external');
  });

  it('puts a read-only tool at read even when it is open world', () => {
    expect(classifyToolRisk({ annotations: { readOnlyHint: true, openWorldHint: true } })).toBe(
      'read',
    );
  });

  it('puts a destructive closed-world tool at write', () => {
    expect(classifyToolRisk({ annotations: { destructiveHint: true, openWorldHint: false } })).toBe(
      'write',
    );
  });
});

describe('ordering', () => {
  it('ranks read < write < external', () => {
    expect(
      ['external', 'read', 'write'].sort((a, b) => riskRank(a as never) - riskRank(b as never)),
    ).toEqual(['read', 'write', 'external']);
    expect(maxRisk('read', 'write')).toBe('write');
    expect(maxRisk('external', 'write')).toBe('external');
    expect(minRisk('read', 'write')).toBe('read');
    expect(minRisk('external', 'write')).toBe('write');
  });

  it('recognizes only the three levels', () => {
    expect(['read', 'write', 'external'].every(isToolRiskLevel)).toBe(true);
    for (const value of ['', 'Read', 'admin', null, undefined, 1, {}]) {
      expect(isToolRiskLevel(value)).toBe(false);
    }
  });
});

describe('effective level', () => {
  const tool = { name: 'svc::get', annotations: { readOnlyHint: true } };

  it('is the computed level without an override', () => {
    expect(getEffectiveToolRisk('svc', tool, {})).toBe('read');
    expect(getToolRiskInfo('svc', tool, undefined)).toEqual({
      computed: 'read',
      effective: 'read',
    });
  });

  it('raises the level, under the runtime or the bare key', () => {
    expect(getEffectiveToolRisk('svc', tool, { toolRiskOverrides: { 'svc::get': 'write' } })).toBe(
      'write',
    );
    expect(getEffectiveToolRisk('svc', tool, { toolRiskOverrides: { get: 'external' } })).toBe(
      'external',
    );
    expect(getToolRiskInfo('svc', tool, { toolRiskOverrides: { get: 'write' } })).toEqual({
      computed: 'read',
      override: 'write',
      effective: 'write',
    });
  });

  it('never lowers the level, however the override got there', () => {
    const send = { name: 'svc::send' };
    expect(getEffectiveToolRisk('svc', send, { toolRiskOverrides: { send: 'read' } })).toBe(
      'external',
    );
  });

  it('ignores malformed stored overrides', () => {
    for (const toolRiskOverrides of [null, 'write', ['write'], { get: 'bogus' }, { get: 3 }]) {
      expect(getEffectiveToolRisk('svc', tool, { toolRiskOverrides } as never)).toBe('read');
    }
  });

  it('does not read another tool’s runtime key as a bare name', () => {
    const names = ['svc::scrape', 'svc::svc::scrape'];
    // `svc::scrape` is the runtime name of `scrape`, not the bare name of `svc::scrape`.
    expect(
      getEffectiveToolRisk(
        'svc',
        { name: 'svc::svc::scrape', annotations: { readOnlyHint: true } },
        { toolRiskOverrides: { 'svc::scrape': 'external' } },
        names,
      ),
    ).toBe('read');
  });
});

describe('getMaxToolRisk', () => {
  it('defaults to external (no cap)', () => {
    expect(getMaxToolRisk(undefined)).toBe('external');
    expect(getMaxToolRisk({})).toBe('external');
  });

  it('returns a valid cap and ignores a malformed one', () => {
    expect(getMaxToolRisk({ maxToolRisk: 'read' })).toBe('read');
    expect(getMaxToolRisk({ maxToolRisk: 'write' })).toBe('write');
    expect(getMaxToolRisk({ maxToolRisk: 'bogus' as never })).toBe('external');
    expect(getMaxToolRisk({ maxToolRisk: null as never })).toBe('external');
  });
});

describe('normalizeMaxToolRisk', () => {
  it('stores external, null and empty as no cap', () => {
    for (const value of ['external', null, undefined, '']) {
      expect(normalizeMaxToolRisk(value)).toBeUndefined();
    }
    expect(normalizeMaxToolRisk('read')).toBe('read');
    expect(normalizeMaxToolRisk('write')).toBe('write');
  });

  it('rejects anything else', () => {
    for (const value of ['Read', 'admin', 3, {}, true]) {
      expect(() => normalizeMaxToolRisk(value)).toThrow(ServerConfigValidationError);
    }
  });
});

describe('normalizeToolRiskOverrides', () => {
  it('keeps valid entries and trims names', () => {
    expect(normalizeToolRiskOverrides({ ' a ': 'write', b: 'external' })).toEqual({
      a: 'write',
      b: 'external',
    });
  });

  it('stores none, null and an empty map as absent', () => {
    for (const value of [undefined, null, {}]) {
      expect(normalizeToolRiskOverrides(value)).toBeUndefined();
    }
  });

  it.each([
    ['an array', ['read']],
    ['a string', 'read'],
    ['an invalid level', { a: 'high' }],
    ['a non-string level', { a: 1 }],
    ['an empty name', { ' ': 'read' }],
    ['a prototype name', JSON.parse('{"__proto__": "read"}')],
    ['a constructor name', { constructor: 'read' }],
    ['a too long name', { ['x'.repeat(513)]: 'read' }],
  ])('rejects %s', (_label, value) => {
    expect(() => normalizeToolRiskOverrides(value)).toThrow(ServerConfigValidationError);
  });
});

describe('assertOverridesOnlyRaise', () => {
  const tools = [
    { name: 'svc::get', annotations: { readOnlyHint: true } },
    { name: 'svc::edit', annotations: { openWorldHint: false } },
    { name: 'svc::send' },
  ];

  it('accepts equal and higher levels, for known tools under either key', () => {
    expect(() =>
      assertOverridesOnlyRaise(
        { get: 'read', 'svc::edit': 'external', send: 'external' },
        'svc',
        tools,
      ),
    ).not.toThrow();
  });

  it.each([[{ edit: 'read' }], [{ 'svc::send': 'write' }], [{ send: 'read' }]])(
    'rejects a lower level: %j',
    (overrides) => {
      expect(() => assertOverridesOnlyRaise(overrides as never, 'svc', tools)).toThrow(
        /can only raise/,
      );
    },
  );

  it('cannot check a tool the server does not list, and accepts nothing at all', () => {
    expect(() => assertOverridesOnlyRaise({ unknown: 'read' }, 'svc', tools)).not.toThrow();
    expect(() => assertOverridesOnlyRaise(undefined, 'svc', tools)).not.toThrow();
    expect(() => assertOverridesOnlyRaise({ a: 'read' }, 'svc', [])).not.toThrow();
  });
});

describe('toolRiskChanged', () => {
  it('compares the cap and the overrides, not their key order or absence markers', () => {
    expect(toolRiskChanged(undefined, {})).toBe(false);
    expect(toolRiskChanged({ maxToolRisk: 'external' }, {})).toBe(false);
    expect(
      toolRiskChanged(
        { toolRiskOverrides: { a: 'write', b: 'external' } },
        { toolRiskOverrides: { b: 'external', a: 'write' } },
      ),
    ).toBe(false);
    expect(toolRiskChanged({}, { maxToolRisk: 'read' })).toBe(true);
    expect(toolRiskChanged({ maxToolRisk: 'read' }, {})).toBe(true);
    expect(toolRiskChanged({ toolRiskOverrides: { a: 'write' } }, {})).toBe(true);
    expect(
      toolRiskChanged(
        { toolRiskOverrides: { a: 'write' } },
        { toolRiskOverrides: { a: 'external' } },
      ),
    ).toBe(true);
  });
});

describe('annotation trust', () => {
  const get = { name: 'svc::get', annotations: { readOnlyHint: true } };

  it('makes every tool external for a server whose annotations are not believed', () => {
    expect(getEffectiveToolRisk('svc', get, {}, [], false)).toBe('external');
    expect(getToolRiskInfo('svc', get, {}, [], false)).toEqual({
      computed: 'external',
      effective: 'external',
    });
    expect(getEffectiveToolRisk('svc', get, {}, [], true)).toBe('read');
  });

  it('keeps overrides in play, which can only keep or raise', () => {
    expect(
      getEffectiveToolRisk('svc', get, { toolRiskOverrides: { get: 'read' } }, [], false),
    ).toBe('external');
  });

  it('judges the raise-only rule against the level that applies', () => {
    expect(() => assertOverridesOnlyRaise({ get: 'write' }, 'svc', [get], true)).not.toThrow();
    expect(() => assertOverridesOnlyRaise({ get: 'write' }, 'svc', [get], false)).toThrow(
      /already external/,
    );
  });
});

describe('the default level for users', () => {
  it('is read unless the administrator set a valid one', () => {
    expect(getDefaultUserRisk(undefined)).toBe('read');
    expect(getDefaultUserRisk({})).toBe('read');
    expect(getDefaultUserRisk({ defaultUserRisk: 'write' })).toBe('write');
    expect(getDefaultUserRisk({ defaultUserRisk: 'external' })).toBe('external');
    expect(getDefaultUserRisk({ defaultUserRisk: 'bogus' as never })).toBe('read');
  });

  it('stores read, null and empty as no default and rejects anything else', () => {
    for (const value of ['read', null, undefined, '']) {
      expect(normalizeDefaultUserRisk(value)).toBeUndefined();
    }
    expect(normalizeDefaultUserRisk('write')).toBe('write');
    expect(normalizeDefaultUserRisk('external')).toBe('external');
    expect(() => normalizeDefaultUserRisk('admin')).toThrow(ServerConfigValidationError);
  });

  it('may not exceed the cap', () => {
    expect(() => assertDefaultWithinCap('write', 'read')).toThrow(/cannot exceed/);
    expect(() => assertDefaultWithinCap('external', 'write')).toThrow(/cannot exceed/);
    expect(() => assertDefaultWithinCap('write', 'write')).not.toThrow();
    expect(() => assertDefaultWithinCap('external', undefined)).not.toThrow();
    expect(() => assertDefaultWithinCap(undefined, 'read')).not.toThrow();
  });

  it('counts as a change of the tool risk controls', () => {
    expect(toolRiskChanged({}, { defaultUserRisk: 'write' })).toBe(true);
    expect(toolRiskChanged({ defaultUserRisk: 'read' }, {})).toBe(false);
  });
});
