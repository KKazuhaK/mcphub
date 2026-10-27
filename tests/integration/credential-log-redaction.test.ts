jest.mock('openid-client', () => ({}));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { randomBytes } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server as McpServer } from '@modelcontextprotocol/server';
import { getServerDao } from '../../src/dao/DaoFactory.js';
import { JsonFileDaoFactory, setDaoFactory } from '../../src/dao/DaoFactory.js';
import { clearSettingsCache } from '../../src/config/index.js';
import { saveCredentialBinding } from '../../src/services/credentialBindingService.js';
import {
  cleanupAllServers,
  handleCallToolRequest,
  initializeClientsFromSettings,
} from '../../src/services/mcpService.js';
import { UserContextService } from '../../src/services/userContextService.js';
import type { McpSettings, ServerConfig } from '../../src/types/index.js';

jest.mock('../../src/services/oauthService.js', () => ({ initializeAllOAuthClients: jest.fn() }));
jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  removeToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn(),
  syncAllServerToolsEmbeddings: jest.fn(),
}));
jest.mock('../../src/services/mcpOAuthProvider.js', () => ({ createOAuthProvider: jest.fn() }));
const activityRows: unknown[] = [];
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: () => ({
    logToolCall: jest.fn(async (row: unknown) => {
      activityRows.push(row);
    }),
  }),
}));
jest.mock('../../src/services/toolResultCompressionService.js', () => ({
  maybeCompressToolResult: (result: unknown) => result,
}));
jest.mock('../../src/services/betterAuthConfig.js', () => ({
  getBetterAuthRuntimeConfig: jest.fn(async () => ({ enabled: false })),
}));

// Distinctive values, one per slot target. None may ever appear in a log line, an activity row
// or a message returned to the caller.
const MARKERS = {
  env: 'MARKER-ENV-5c1d9e7a',
  args: 'MARKER-ARGS-b24f08e3',
  header: 'MARKER-HEADER-77aa31d0',
  urlPath: 'MARKER-URLPATH-e9120c4b',
  urlHost: 'markerhost8d3f6a21',
};

const alice = 'alice@example.com';
let directory: string;
let server: HttpServer;
let baseUrl: string;
const originalEnv = {
  path: process.env.MCPHUB_SETTING_PATH,
  key: process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY,
  useDb: process.env.USE_DB,
};
const fixture = path.resolve('tests/fixtures/marker-server.mjs');

const captured: string[] = [];
const spies: jest.SpyInstance[] = [];
const startCapture = () => {
  captured.length = 0;
  activityRows.length = 0;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    spies.push(
      jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        captured.push(
          util.inspect(args, { depth: 8, maxStringLength: null, breakLength: Infinity }),
        );
      }),
    );
  }
};
const stopCapture = () => {
  for (const spy of spies.splice(0)) spy.mockRestore();
};
const everythingObserved = (result: unknown) =>
  [captured.join('\n'), JSON.stringify(activityRows), JSON.stringify(result)].join('\n');
const expectNoMarkers = (observed: string) => {
  for (const marker of Object.values(MARKERS)) expect(observed).not.toContain(marker);
};

const callAsAlice = (serverName: string) =>
  UserContextService.getInstance().runWithContext(
    () =>
      handleCallToolRequest(
        { params: { name: 'ping' } },
        { server: serverName, group: serverName },
      ),
    { username: alice, password: '', isAdmin: false },
  );

const bind = async (name: string, values: Record<string, string>) => {
  const definition = (await getServerDao().findById(name)) as ServerConfig;
  await saveCredentialBinding(name, alice, definition, values);
};

beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcphub-redaction-'));
  process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.USE_DB = 'false';
  const common = { owner: 'admin', visibility: 'public' as const };
  const settings = {
    mcpServers: {
      stdioOk: {
        ...common,
        type: 'stdio',
        command: process.execPath,
        args: [fixture, '{{args.KEY}}'],
        env: { MARKER_ENV: 'org-default-value' },
        credentialTemplate: [
          { target: 'env', name: 'MARKER_ENV' },
          { target: 'args', name: 'KEY' },
        ],
      },
      stdioFail: {
        ...common,
        type: 'stdio',
        command: process.execPath,
        args: [fixture, '--fail', '{{args.KEY}}'],
        env: { MARKER_ENV: 'org-default-value' },
        credentialTemplate: [
          { target: 'env', name: 'MARKER_ENV' },
          { target: 'args', name: 'KEY' },
        ],
      },
      httpOk: {
        ...common,
        type: 'streamable-http',
        oauth: {},
        url: '__BASE__/ok-upstream',
        credentialTemplate: [{ target: 'headers', name: 'X-Marker-Key' }],
      },
      httpFail: {
        ...common,
        type: 'streamable-http',
        oauth: {},
        url: '__BASE__/fail-upstream',
        credentialTemplate: [{ target: 'headers', name: 'X-Marker-Key' }],
      },
      urlPathOk: {
        ...common,
        type: 'streamable-http',
        oauth: {},
        url: '__BASE__/{{url.tenant}}/ok-upstream',
        credentialTemplate: [
          { target: 'url', name: 'tenant', allowed: [MARKERS.urlPath] },
          { target: 'headers', name: 'X-Marker-Key' },
        ],
      },
      urlHostFail: {
        ...common,
        type: 'streamable-http',
        oauth: {},
        url: 'http://{{url.region}}.marker-redaction.invalid/mcp',
        credentialTemplate: [
          { target: 'url', name: 'region', allowed: [MARKERS.urlHost] },
          { target: 'headers', name: 'X-Marker-Key' },
        ],
      },
    },
    users: ['admin', alice].map((username) => ({
      username,
      password: 'unused',
      isAdmin: username === 'admin',
    })),
    groups: [],
    bearerKeys: [],
    systemConfig: {
      network: { allowedCidrs: ['127.0.0.0/8'] },
      routing: { enableBearerAuth: false, skipAuth: false },
      oauthServer: { enabled: false },
    },
  } as unknown as McpSettings;

  const app = express();
  app.use(express.json());
  const mcpUpstream = async (req: express.Request, res: express.Response) => {
    const upstream = new McpServer(
      { name: 'http-marker', version: '1' },
      { capabilities: { tools: {} } },
    );
    upstream.setRequestHandler('tools/list', async () => ({
      tools: [{ name: 'ping', inputSchema: { type: 'object' } }],
    }));
    upstream.setRequestHandler('tools/call', async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void upstream.close();
    });
    await upstream.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
  app.post('/ok-upstream', mcpUpstream);
  app.post('/:tenant/ok-upstream', mcpUpstream);
  // A careless upstream error page: it echoes the request line and every header it received.
  app.post('/fail-upstream', (req, res) =>
    res
      .status(500)
      .send(`upstream exploded handling ${req.originalUrl} headers=${JSON.stringify(req.headers)}`),
  );
  server = await new Promise<HttpServer>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  fs.writeFileSync(
    process.env.MCPHUB_SETTING_PATH,
    JSON.stringify(settings).split('__BASE__').join(baseUrl),
  );
  clearSettingsCache();
  JsonFileDaoFactory.getInstance().resetInstances();
  setDaoFactory(JsonFileDaoFactory.getInstance());
  await initializeClientsFromSettings(true);
});

afterAll(async () => {
  stopCapture();
  cleanupAllServers();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  for (const [name, value] of Object.entries({
    MCPHUB_SETTING_PATH: originalEnv.path,
    MCPHUB_CREDENTIAL_ENCRYPTION_KEY: originalEnv.key,
    USE_DB: originalEnv.useDb,
  })) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  clearSettingsCache();
  JsonFileDaoFactory.getInstance().resetInstances();
});

afterEach(stopCapture);

describe('resolved credential slot values never reach logs, activity rows or error messages', () => {
  it('stdio env + args slots: success path', async () => {
    await bind('stdioOk', { 'env.MARKER_ENV': MARKERS.env, 'args.KEY': MARKERS.args });
    startCapture();

    const result = await callAsAlice('stdioOk');

    expect(JSON.stringify(result)).toContain('pong');
    expect(captured.length).toBeGreaterThan(0);
    expectNoMarkers(everythingObserved(result));
  });

  it('stdio env + args slots: connect failure (the child echoes both to stderr)', async () => {
    await bind('stdioFail', { 'env.MARKER_ENV': MARKERS.env, 'args.KEY': MARKERS.args });
    startCapture();

    const result = await callAsAlice('stdioFail');

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(result)).toContain('stdioFail');
    expect(captured.join('\n')).toContain('stdioFail');
    expectNoMarkers(everythingObserved(result));
  });

  it('header slot: success path', async () => {
    await bind('httpOk', { 'headers.X-Marker-Key': MARKERS.header });
    startCapture();

    const result = await callAsAlice('httpOk');

    expect(JSON.stringify(result)).toContain('pong');
    expectNoMarkers(everythingObserved(result));
  });

  it('header slot: connect failure whose response body echoes the request headers', async () => {
    await bind('httpFail', { 'headers.X-Marker-Key': MARKERS.header });
    startCapture();

    const result = await callAsAlice('httpFail');

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(result)).toContain('500');
    expectNoMarkers(everythingObserved(result));
  });

  it('url path slot + header slot: success path', async () => {
    await bind('urlPathOk', {
      'url.tenant': MARKERS.urlPath,
      'headers.X-Marker-Key': MARKERS.header,
    });
    startCapture();

    const result = await callAsAlice('urlPathOk');

    expect(JSON.stringify(result)).toContain('pong');
    expectNoMarkers(everythingObserved(result));
  });

  it('url host-label slot: failure whose message names the resolved host', async () => {
    await bind('urlHostFail', {
      'url.region': MARKERS.urlHost,
      'headers.X-Marker-Key': MARKERS.header,
    });
    startCapture();

    const result = await callAsAlice('urlHostFail');

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(captured.join('\n')).toContain('urlHostFail');
    expectNoMarkers(everythingObserved(result));
  });
});
