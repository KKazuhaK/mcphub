import {
  classifyResource,
  isValidExternalResourceUrl,
  normalizeExternalResources,
} from '../../src/utils/externalResources.js';

const config = {
  oauthServer: {
    externalResources: [
      { resource: 'https://ubc.example/mcp', name: 'UBC', allowedClients: ['a'] },
      { resource: 'https://open.example/mcp', name: 'Open' },
    ],
  },
};
const own = { origins: ['https://hub.example.com'], strict: true };

describe('external resource URLs', () => {
  it.each([
    ['https://ubc.example/mcp', true],
    ['https://ubc.example', true],
    ['http://localhost:3000/mcp', true],
    ['http://127.0.0.1/mcp', true],
    ['http://[::1]:8080/mcp', true],
    ['http://ubc.example/mcp', false],
    ['http://localhost.evil.example/mcp', false],
    ['ftp://ubc.example/mcp', false],
    ['https://ubc.example/mcp#frag', false],
    ['https://user:pw@ubc.example/mcp', false],
    ['ubc.example/mcp', false],
    ['', false],
    [42, false],
  ])('%s -> %s', (value, expected) => {
    expect(isValidExternalResourceUrl(value)).toBe(expected);
  });

  it('normalizes names and de-duplicates allowed clients', () => {
    expect(
      normalizeExternalResources([
        { resource: 'https://ubc.example/mcp', name: ' UBC ', allowedClients: ['a', 'a', 'b'] },
      ]),
    ).toEqual([{ resource: 'https://ubc.example/mcp', name: 'UBC', allowedClients: ['a', 'b'] }]);
  });
});

describe('classifyResource', () => {
  it('has no opinion on an absent resource', () => {
    expect(classifyResource(undefined, config, own)).toEqual({ kind: 'none' });
    expect(classifyResource('', config, own)).toEqual({ kind: 'none' });
  });

  it('matches a configured resource exactly', () => {
    expect(classifyResource('https://ubc.example/mcp', config, own, 'a').kind).toBe('external');
    expect(classifyResource('https://ubc.example/mcp/', config, own, 'a').kind).toBe('invalid');
    expect(classifyResource('https://UBC.example/mcp', config, own, 'a').kind).toBe('invalid');
  });

  it('applies allowedClients only when the client is known', () => {
    expect(classifyResource('https://ubc.example/mcp', config, own, 'b').kind).toBe('invalid');
    expect(classifyResource('https://ubc.example/mcp', config, own).kind).toBe('external');
    expect(classifyResource('https://open.example/mcp', config, own, 'anyone').kind).toBe(
      'external',
    );
  });

  it("treats MCPHub's own origin as its own routes", () => {
    expect(classifyResource('https://hub.example.com/mcp/team', config, own).kind).toBe('own');
    expect(classifyResource('https://hub.example.com:8443/mcp', config, own).kind).toBe('invalid');
  });

  it('without a configured public URL, also takes anything shaped like an MCP route', () => {
    const lenient = { origins: ['http://internal:3000'], strict: false };
    expect(classifyResource('https://public.example/mcp/team', config, lenient).kind).toBe('own');
    expect(classifyResource('https://public.example/mcp', config, lenient).kind).toBe('own');
    expect(classifyResource('https://public.example/other', config, lenient).kind).toBe('invalid');
    // A configured resource still wins, and a disallowed client still cannot have it.
    expect(classifyResource('https://ubc.example/mcp', config, lenient, 'a').kind).toBe('external');
    expect(classifyResource('https://ubc.example/mcp', config, lenient, 'b').kind).toBe('invalid');
  });

  it('refuses anything else and anything that is not a single string', () => {
    expect(classifyResource('https://evil.example/mcp', config, own).kind).toBe('invalid');
    expect(classifyResource('not a url', config, own).kind).toBe('invalid');
    expect(classifyResource(['https://ubc.example/mcp'], config, own).kind).toBe('invalid');
  });
});
