/** Dashboard authentication is simulated here; the real controller and encrypted file store run. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { CredentialBindingDaoImpl } from '../../src/dao/CredentialBindingDao.js';
import {
  listMyCredentials,
  updateMyCredential,
} from '../../src/controllers/credentialBindingController.js';
import {
  saveCredentialBinding,
  getCredentialBindingStatus,
} from '../../src/services/credentialBindingService.js';
import {
  authorizationService,
  type RequestPrincipal,
} from '../../src/services/authorizationService.js';
import type { ServerConfig } from '../../src/types/index.js';
const server: ServerConfig & { name: string } = {
  name: 'canvas',
  command: 'uvx',
  type: 'stdio',
  visibility: 'public',
  owner: 'admin',
  credentialTemplate: [
    { target: 'env', name: 'CANVAS_API_URL' },
    { target: 'env', name: 'CANVAS_API_TOKEN' },
  ],
};
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getCredentialBindingDao: () => new CredentialBindingDaoImpl(),
  getServerDao: () => ({
    findAll: async () => [server],
    findById: async (name: string) => (name === 'canvas' ? server : null),
  }),
  getUserDao: () => ({
    findById: async (username: string) => ({ username, email: `${username}@example.com` }),
  }),
}));
let principal: RequestPrincipal | undefined;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  Object.assign(req, { user: principal });
  next();
});
app.get('/credentials', listMyCredentials);
app.put('/credentials/:name', updateMyCredential);
let directory: string;
let savedEnv: NodeJS.ProcessEnv;
beforeEach(async () => {
  savedEnv = { ...process.env };
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-reminder-api-'));
  process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  principal = { username: 'alice' };
  for (const username of ['alice', 'bob'])
    await saveCredentialBinding('canvas', username, server, {
      'env.CANVAS_API_URL': 'https://canvas.example.edu',
      'env.CANVAS_API_TOKEN': `${username}-private-token`,
    });
});
afterEach(() => {
  process.env = savedEnv;
  fs.rmSync(directory, { recursive: true, force: true });
  jest.restoreAllMocks();
});
test('changes only the authenticated owner even if the request body spoofs another user', async () => {
  await request(app)
    .put('/credentials/canvas')
    .send({ username: 'bob', reminder: { enabled: true, days: 7 } })
    .expect(200);
  expect(
    (await getCredentialBindingStatus('canvas', 'alice', server)).canvasReminder?.enabled,
  ).toBe(true);
  expect((await getCredentialBindingStatus('canvas', 'bob', server)).canvasReminder?.enabled).toBe(
    false,
  );
  const response = await request(app).get('/credentials').expect(200);
  expect(response.body.data[0]).toMatchObject({
    canvasReminder: { enabled: true },
    reminderEmailAvailable: true,
  });
  expect(JSON.stringify(response.body)).not.toContain('private-token');
  expect(JSON.stringify(response.body)).not.toContain('example.edu');
});
test('requires an eligible authenticated user and authorized server', async () => {
  principal = undefined;
  await request(app)
    .put('/credentials/canvas')
    .send({ reminder: { enabled: true, days: 7 } })
    .expect(401);
  principal = { username: 'alice', credentialEligible: false };
  await request(app).get('/credentials').expect(401);
  principal = { username: 'alice' };
  jest.spyOn(authorizationService, 'can').mockReturnValue(false);
  await request(app)
    .put('/credentials/canvas')
    .send({ reminder: { enabled: true, days: 7 } })
    .expect(404);
});
test('rejects malformed dates and limits without changing the binding', async () => {
  await request(app)
    .put('/credentials/canvas')
    .send({ reminder: { enabled: true, days: 500 } })
    .expect(400);
  expect(
    (await getCredentialBindingStatus('canvas', 'alice', server)).canvasReminder?.enabled,
  ).toBe(false);
});
