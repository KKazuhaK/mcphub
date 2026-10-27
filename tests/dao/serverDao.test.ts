import { ServerDaoImpl } from '../../src/dao/ServerDao.js';

describe('ServerDaoImpl', () => {
  it('includes explicitly shared group servers in paginated user results', async () => {
    const dao = new ServerDaoImpl();
    jest.spyOn(dao as any, 'getAll').mockResolvedValue([
      { name: 'owned', owner: 'alice', visibility: 'private' },
      { name: 'public', owner: 'bob', visibility: 'public' },
      {
        name: 'shared',
        owner: 'bob',
        visibility: 'group',
        sharedWithUsers: ['alice'],
      },
      {
        name: 'unshared',
        owner: 'bob',
        visibility: 'group',
        sharedWithUsers: ['charlie'],
      },
    ]);

    const result = await dao.findVisibleToUserPaginated('alice', 1, 10);

    expect(result.data.map((server) => server.name)).toEqual(['owned', 'public', 'shared']);
    expect(result.total).toBe(3);
  });

  it('unpacks startOnDemand/idleTimeoutMs mirrored into options and strips them from the stored options blob', async () => {
    // JSON-mode storage keeps configs verbatim, so without this the mirrored
    // keys added for database-mode persistence would leak into API responses
    // and the on-disk mcp_settings.json as user-visible noise, even though
    // JSON mode never needed the mirror in the first place.
    const dao = new ServerDaoImpl();
    jest.spyOn(dao as any, 'loadSettings').mockResolvedValue({
      mcpServers: {
        'on-demand-server': {
          type: 'stdio',
          command: 'npx',
          args: ['-y', 'demo-server'],
          enabled: true,
          options: {
            timeout: 5000,
            startOnDemand: true,
            idleTimeoutMs: 120000,
          },
        },
      },
    });

    const servers = await (dao as any).getAll();
    const server = servers.find((s: any) => s.name === 'on-demand-server');

    expect(server.startOnDemand).toBe(true);
    expect(server.idleTimeoutMs).toBe(120000);
    expect(server.options).toEqual({ timeout: 5000 });
  });
  describe('maintenance and per-user pause', () => {
    const stored = {
      name: 'maintained',
      type: 'sse',
      url: 'https://example.com/sse',
      pausedUsers: ['bob'],
      maintenance: { until: '2026-10-27T18:00:00.000Z', message: 'Upgrading.' },
    };
    const run = async (updates: object) => {
      const dao = new ServerDaoImpl();
      jest
        .spyOn(dao as any, 'loadSettings')
        .mockResolvedValue({ mcpServers: { maintained: stored } });
      const save = jest.spyOn(dao as any, 'saveSettings').mockResolvedValue(undefined);
      await dao.update('maintained', updates);
      return JSON.parse(JSON.stringify(save.mock.calls[0][0].mcpServers.maintained));
    };

    it('stores both fields in the settings file and reads them back', async () => {
      const dao = new ServerDaoImpl();
      jest
        .spyOn(dao as any, 'loadSettings')
        .mockResolvedValue({ mcpServers: { maintained: stored } });

      const server = await dao.findById('maintained');

      expect(server?.pausedUsers).toEqual(['bob']);
      expect(server?.maintenance).toEqual(stored.maintenance);
    });

    it('keeps them through an update that does not name them', async () => {
      const saved = await run({ description: 'edited' });

      expect(saved.pausedUsers).toEqual(['bob']);
      expect(saved.maintenance).toEqual(stored.maintenance);
    });

    it('removes them when an update clears them', async () => {
      const saved = await run({ pausedUsers: undefined, maintenance: undefined });

      expect(saved).not.toHaveProperty('pausedUsers');
      expect(saved).not.toHaveProperty('maintenance');
    });
  });

  describe('tool risk controls', () => {
    const stored = {
      name: 'risky',
      type: 'sse',
      url: 'https://example.com/sse',
      maxToolRisk: 'write',
      defaultUserRisk: 'write',
      toolRiskOverrides: { 'risky::get': 'external' },
    };
    const run = async (updates: object) => {
      const dao = new ServerDaoImpl();
      jest.spyOn(dao as any, 'loadSettings').mockResolvedValue({ mcpServers: { risky: stored } });
      const save = jest.spyOn(dao as any, 'saveSettings').mockResolvedValue(undefined);
      await dao.update('risky', updates);
      return JSON.parse(JSON.stringify(save.mock.calls[0][0].mcpServers.risky));
    };

    it('stores the cap and the overrides in the settings file and reads them back', async () => {
      const dao = new ServerDaoImpl();
      jest.spyOn(dao as any, 'loadSettings').mockResolvedValue({ mcpServers: { risky: stored } });

      const server = await dao.findById('risky');

      expect(server?.maxToolRisk).toBe('write');
      expect(server?.defaultUserRisk).toBe('write');
      expect(server?.toolRiskOverrides).toEqual({ 'risky::get': 'external' });
    });

    it('keeps them through an update that does not name them', async () => {
      const saved = await run({ description: 'edited' });

      expect(saved.maxToolRisk).toBe('write');
      expect(saved.defaultUserRisk).toBe('write');
      expect(saved.toolRiskOverrides).toEqual({ 'risky::get': 'external' });
    });

    it('removes them when an update clears them', async () => {
      const saved = await run({ maxToolRisk: undefined, toolRiskOverrides: undefined });

      expect(saved).not.toHaveProperty('maxToolRisk');
      expect(saved).toHaveProperty('defaultUserRisk', 'write');
      expect(await run({ defaultUserRisk: undefined })).not.toHaveProperty('defaultUserRisk');
      expect(saved).not.toHaveProperty('toolRiskOverrides');
    });
  });
});

describe('credentialWriteClients (file mode)', () => {
  const stored = {
    name: 'ubc',
    type: 'sse',
    url: 'https://example.com/sse',
    credentialWriteClients: ['ubc-client'],
  };
  const run = async (updates: object) => {
    const dao = new ServerDaoImpl();
    jest.spyOn(dao as any, 'loadSettings').mockResolvedValue({ mcpServers: { ubc: stored } });
    const save = jest.spyOn(dao as any, 'saveSettings').mockResolvedValue(undefined);
    await dao.update('ubc', updates);
    return JSON.parse(JSON.stringify(save.mock.calls[0][0].mcpServers.ubc));
  };

  it('reads the list back, keeps it through unrelated updates and removes it when cleared', async () => {
    const dao = new ServerDaoImpl();
    jest.spyOn(dao as any, 'loadSettings').mockResolvedValue({ mcpServers: { ubc: stored } });
    expect((await dao.findById('ubc'))?.credentialWriteClients).toEqual(['ubc-client']);

    expect((await run({ description: 'edited' })).credentialWriteClients).toEqual(['ubc-client']);
    expect(await run({ credentialWriteClients: undefined })).not.toHaveProperty(
      'credentialWriteClients',
    );
  });
});
