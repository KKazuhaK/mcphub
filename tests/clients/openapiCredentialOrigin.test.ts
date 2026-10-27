// Personal credential values may only be sent to the origin an OpenAPI server declares (the
// origin of its document URL). A document whose `servers` points elsewhere gets no slot value.

const instances: any[] = [];
const makeInstance = () => ({
  defaults: { headers: { common: {} as Record<string, string> } },
  interceptors: { request: { use: jest.fn() } },
  get: jest.fn(),
  request: jest.fn(),
});
jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => {
      const instance = makeInstance();
      instances.push(instance);
      return instance;
    }),
    isAxiosError: () => false,
  },
  AxiosHeaders: {
    from: (headers: Record<string, string>) => ({
      ...headers,
      set(name: string, value: string) {
        this[name] = value;
      },
    }),
  },
}));
jest.mock('@apidevtools/swagger-parser', () => ({
  __esModule: true,
  default: { dereference: jest.fn(async (_url: unknown, doc: unknown) => doc) },
}));
const mockUserDao = { findByUsername: jest.fn() };
jest.mock('../../src/dao/index.js', () => ({ getUserDao: () => mockUserDao }));

import { OpenAPIClient } from '../../src/clients/openapi.js';
import {
  DestinationMismatchError,
  MissingCredentialError,
} from '../../src/utils/credentialTemplate.js';
import { logger } from '../../src/utils/logger.js';

const DECLARED = 'http://127.0.0.1:8443';
const spec = (serverUrl: string | undefined) => ({
  openapi: '3.0.0',
  info: { title: 'API', version: '1.0.0' },
  ...(serverUrl ? { servers: [{ url: serverUrl }] } : {}),
  paths: { '/ping': { get: { operationId: 'ping', responses: { '200': { description: 'ok' } } } } },
});
const SECRET = 'Bearer alice-secret';

const makeClient = async (serverUrl: string | undefined, withTemplate = true) => {
  const client = new OpenAPIClient({
    type: 'openapi',
    owner: 'admin',
    openapi: { url: `${DECLARED}/openapi.json` },
    headers: { Authorization: SECRET },
    ...(withTemplate ? { credentialTemplate: [{ target: 'headers', name: 'Authorization' }] } : {}),
  } as never);
  instances[0].get.mockResolvedValue({ data: JSON.stringify(spec(serverUrl)), headers: {} });
  instances[0].request.mockResolvedValue({ data: { ok: true }, headers: {} });
  await client.initialize();
  return client;
};

beforeEach(() => {
  instances.length = 0;
  jest.clearAllMocks();
  mockUserDao.findByUsername.mockResolvedValue({ username: 'admin', isAdmin: true });
});

test('sends the slot value when the request goes to the declared origin', async () => {
  const client = await makeClient(`${DECLARED}/api`);
  await client.callTool('ping', {});
  const sent = instances[0].request.mock.calls[0][0];
  expect(sent.baseURL).toBe(DECLARED);
  expect(sent.headers.Authorization).toBe(SECRET);
});

test('refuses, without sending anything, when servers[0] points to another origin', async () => {
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const client = await makeClient('https://evil.example.net/api');
  const failure = await client.callTool('ping', {}).catch((error) => error);
  expect(failure).toBeInstanceOf(DestinationMismatchError);
  expect(failure).toBeInstanceOf(MissingCredentialError);
  expect(failure.reason).toBe('destination_mismatch');
  expect(failure.message).not.toContain('alice-secret');
  expect(instances[0].request).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('Refusing to send personal credentials'),
    expect.objectContaining({
      declaredOrigin: DECLARED,
      requestOrigin: 'https://evil.example.net',
    }),
  );
});

test('refuses a different port or scheme of the same host too', async () => {
  for (const other of ['http://127.0.0.1:9999', 'https://127.0.0.1:8443']) {
    instances.length = 0;
    const client = await makeClient(other);
    await expect(client.callTool('ping', {})).rejects.toBeInstanceOf(DestinationMismatchError);
    expect(instances[0].request).not.toHaveBeenCalled();
  }
});

test('a server without credential slots is not restricted', async () => {
  const client = await makeClient('https://elsewhere.example.net/api', false);
  await client.callTool('ping', {}).catch(() => undefined);
  expect(instances[0].request).toHaveBeenCalled();
});
