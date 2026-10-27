// Harness for the two-user isolation suite: in-process upstream MCP servers (plain HTTP on a
// loopback port, no npx/uvx, no external network) and a real MCPHub `AppServer` that can be
// started again from the same settings file, which is how a restart is simulated.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import express from 'express';
import request from 'supertest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { Server as McpServer } from '@modelcontextprotocol/server';
import { createUserToken } from '../utils/testHelpers.js';

// A short, stable stand-in for a secret: lets a test assert which credential reached an
// upstream without the secret itself ever being echoed, logged or stored in the clear.
export const fingerprint = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 10);

export type UpstreamCall = { server: string; tool: string; fingerprint?: string };

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, openWorldHint: false };
const EXTERNAL = { readOnlyHint: false, openWorldHint: true };
const emptySchema = { type: 'object' as const, properties: {} };

const toolsByServer: Record<string, Array<{ name: string; annotations: object }>> = {
  // A public shared server: no credential, read, write and external tools.
  shared: [
    { name: 'lookup', annotations: READ },
    { name: 'save_note', annotations: WRITE },
    { name: 'send_email', annotations: EXTERNAL },
  ],
  // A server that needs a personal credential (header slot) and echoes a fingerprint of it.
  personal: [{ name: 'whoami', annotations: READ }],
  // A second shared server the administrator puts in maintenance.
  maint: [{ name: 'ping', annotations: READ }],
};

export type Upstreams = {
  baseUrl: string;
  calls: UpstreamCall[];
  close: () => Promise<void>;
};

export const startUpstreams = async (): Promise<Upstreams> => {
  const calls: UpstreamCall[] = [];
  const app = express();
  app.use(express.json());
  for (const [serverName, tools] of Object.entries(toolsByServer)) {
    app.post(`/${serverName}`, async (req, res) => {
      const header = req.headers['x-personal-key'];
      const presented = typeof header === 'string' ? header : undefined;
      const upstream = new McpServer(
        { name: `${serverName}-upstream`, version: '1' },
        { capabilities: { tools: {} } },
      );
      upstream.setRequestHandler('tools/list', async () => ({
        tools: tools.map((tool) => ({ ...tool, inputSchema: emptySchema })),
      }));
      upstream.setRequestHandler('tools/call', async (request) => {
        const entry = {
          server: serverName,
          tool: request.params.name,
          ...(presented ? { fingerprint: fingerprint(presented) } : {}),
        };
        calls.push(entry);
        return { content: [{ type: 'text', text: JSON.stringify(entry) }] };
      });
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        void transport.close();
        void upstream.close();
      });
      await upstream.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  }
  const server = await new Promise<HttpServer>((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const { port } = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

export type Hub = {
  baseUrl: string;
  // Dashboard API request signed in as `username` (a real session token).
  api: (
    method: 'get' | 'put' | 'delete' | 'post',
    path: string,
    username: string,
    body?: object,
  ) => request.Test;
  // A real MCP client over streamable HTTP, authenticated with a user-level bearer key.
  connect: (endpointUser: string, bearer: string) => Promise<Client>;
  stop: () => Promise<void>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Boots the real application (routes, middlewares, auth, session handling, upstream pool) from
// the settings file, in a fresh module registry so no in-memory state survives from the
// previous boot. Only the settings file, its sidecars and the upstreams are shared.
export const startHub = async (settingsPath: string, readyServers: string[]): Promise<Hub> => {
  jest.resetModules();
  process.env.MCPHUB_SETTING_PATH = settingsPath;
  const { AppServer } = await import('../../src/server.js');
  const { cleanupAllServers, getServerByName } = await import('../../src/services/mcpService.js');
  const { transports } = await import('../../src/services/sseService.js');
  const { clearSettingsCache } = await import('../../src/config/index.js');
  clearSettingsCache();

  const appServer = new AppServer();
  await appServer.initialize();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (readyServers.every((name) => getServerByName(name)?.status === 'connected')) break;
    await sleep(50);
  }
  for (const name of readyServers) {
    if (getServerByName(name)?.status !== 'connected') throw new Error(`${name} did not connect`);
  }
  const http = await new Promise<HttpServer>((resolve) => {
    const listener = appServer.getApp().listen(0, '127.0.0.1', () => resolve(listener));
  });
  const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const openClients: Client[] = [];

  return {
    baseUrl,
    api: (method, path, username, body) => {
      const call = request(baseUrl)
        [method](path)
        .set('x-auth-token', createUserToken(username, username === 'admin'));
      return body ? call.send(body) : call;
    },
    connect: async (endpointUser, bearer) => {
      const client = new Client({ name: 'isolation-e2e', version: '1' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${baseUrl}/${endpointUser}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
        }),
      );
      openClients.push(client);
      return client;
    },
    stop: async () => {
      for (const client of openClients) await client.close().catch(() => undefined);
      for (const entry of Object.values(transports)) await entry.transport.close();
      cleanupAllServers();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await sleep(100);
    },
  };
};

export const readSettings = (settingsPath: string) =>
  JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, any>;
