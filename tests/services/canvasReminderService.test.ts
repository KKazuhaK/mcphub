import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { CredentialBindingDaoImpl } from '../../src/dao/CredentialBindingDao.js';
import {
  saveCredentialBinding,
  getCredentialBindingStatus,
  deleteCredentialBindings,
} from '../../src/services/credentialBindingService.js';
import {
  configureCanvasReminder,
  runCanvasReminders,
} from '../../src/services/canvasReminderService.js';
import { discoverCanvasExpiry } from '../../src/services/canvasExpiryService.js';
import { authorizationService } from '../../src/services/authorizationService.js';
import type { ServerConfig } from '../../src/types/index.js';

const server: ServerConfig & { name: string } = {
  name: 'canvas',
  type: 'stdio',
  command: 'uvx',
  visibility: 'public',
  owner: 'admin',
  credentialTemplate: [
    { target: 'env', name: 'CANVAS_API_URL' },
    { target: 'env', name: 'CANVAS_API_TOKEN' },
  ],
};
const findUser = jest.fn();
jest.mock('../../src/dao/DaoFactory.js', () => ({
  getCredentialBindingDao: () => new CredentialBindingDaoImpl(),
  getServerDao: () => ({ findAll: async () => [server] }),
  getUserDao: () => ({ findById: findUser }),
}));
jest.mock('../../src/services/canvasExpiryService.js', () => ({ discoverCanvasExpiry: jest.fn() }));
jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
const sendMail = jest.fn();
let directory: string;
let previousEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  previousEnv = { ...process.env };
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-reminders-'));
  process.env.MCPHUB_SETTING_PATH = path.join(directory, 'settings.json');
  process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.MCPHUB_SMTP_HOST = 'smtp.example.com';
  process.env.MCPHUB_SMTP_FROM = 'hub@example.com';
  process.env.MCPHUB_PUBLIC_URL = 'https://hub.example.com';
  jest.mocked(discoverCanvasExpiry).mockResolvedValue({
    source: 'canvas',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  findUser.mockImplementation(async (username) => ({ username, email: `${username}@example.com` }));
  jest.spyOn(authorizationService, 'can').mockReturnValue(true);
  sendMail.mockReset().mockResolvedValue({ accepted: ['alice@example.com'] });
  jest.mocked(nodemailer.createTransport).mockReturnValue({ sendMail, close: jest.fn() } as never);
});
afterEach(() => {
  process.env = previousEnv;
  fs.rmSync(directory, { recursive: true, force: true });
  jest.restoreAllMocks();
});
const bind = async (username = 'alice', token = 'sentinel-secret-token') =>
  saveCredentialBinding('canvas', username, server, {
    'env.CANVAS_API_URL': 'https://canvas.example.edu',
    'env.CANVAS_API_TOKEN': token,
  });
const enable = async (username = 'alice') =>
  configureCanvasReminder('canvas', username, { enabled: true, days: 7, refresh: true });
const status = async () =>
  (await getCredentialBindingStatus('canvas', 'alice', server)).canvasReminder;

test('backfills existing bindings, defaults to opt-out and encrypts metadata at rest', async () => {
  await bind();
  await runCanvasReminders();
  expect(await status()).toMatchObject({ enabled: false, source: 'canvas' });
  expect(sendMail).not.toHaveBeenCalled();
  expect(
    fs.readFileSync(`${process.env.MCPHUB_SETTING_PATH}.credentials.json`, 'utf8'),
  ).not.toContain('sentinel-secret-token');
  expect(JSON.stringify(await status())).not.toContain('lease');
});
test('sends to the binding owner only, once soon and once expired, persisting deduplication', async () => {
  await bind();
  await bind('bob');
  await enable();
  await Promise.all([runCanvasReminders(), runCanvasReminders()]);
  await runCanvasReminders();
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(sendMail.mock.calls[0][0].to).toBe('alice@example.com');
  expect(JSON.stringify(sendMail.mock.calls)).not.toContain('sentinel-secret-token');
  await configureCanvasReminder('canvas', 'alice', {
    enabled: true,
    days: 7,
    manualExpiresAt: new Date(Date.now() - 10000).toISOString(),
  });
  await runCanvasReminders();
  await runCanvasReminders();
  expect(sendMail).toHaveBeenCalledTimes(2);
});
test('rotation resets consent and deletion prevents reminder delivery', async () => {
  await bind();
  await enable();
  await bind('alice', 'replacement-token');
  await runCanvasReminders();
  expect(sendMail).not.toHaveBeenCalled();
  await enable();
  await deleteCredentialBindings({ serverName: 'canvas', username: 'alice' });
  await runCanvasReminders();
  expect(sendMail).not.toHaveBeenCalled();
});
test('unknown expiry is never guessed, manual expiry can be supplied', async () => {
  jest.mocked(discoverCanvasExpiry).mockResolvedValue({ source: 'unknown', expiresAt: null });
  await bind();
  await enable();
  await runCanvasReminders();
  expect(sendMail).not.toHaveBeenCalled();
  await configureCanvasReminder('canvas', 'alice', {
    enabled: true,
    days: 7,
    manualExpiresAt: new Date(Date.now() + 10000).toISOString(),
  });
  await runCanvasReminders();
  expect(sendMail).toHaveBeenCalledTimes(1);
});
test('failed refresh preserves a previously verified date and failed mail retries after lease', async () => {
  await bind();
  await enable();
  jest.mocked(discoverCanvasExpiry).mockResolvedValue({ source: 'unknown', expiresAt: null });
  await configureCanvasReminder('canvas', 'alice', { enabled: true, days: 7, refresh: true });
  expect(await status()).toMatchObject({ source: 'canvas' });
  sendMail.mockRejectedValueOnce(new Error('smtp failure'));
  await runCanvasReminders();
  await runCanvasReminders();
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(await status()).toMatchObject({ delivery: 'failed' });
  const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 360000);
  await runCanvasReminders();
  expect(sendMail).toHaveBeenCalledTimes(2);
  now.mockRestore();
});
test('skips deleted users, revoked server access, missing email and missing SMTP', async () => {
  await bind();
  await enable();
  findUser.mockResolvedValue(null);
  await runCanvasReminders();
  findUser.mockResolvedValue({ username: 'alice' });
  await runCanvasReminders();
  findUser.mockResolvedValue({ username: 'alice', email: 'alice@example.com' });
  jest.mocked(authorizationService.can).mockReturnValue(false);
  await runCanvasReminders();
  jest.mocked(authorizationService.can).mockReturnValue(true);
  delete process.env.MCPHUB_SMTP_HOST;
  await runCanvasReminders();
  expect(sendMail).not.toHaveBeenCalled();
});
test('rejects invalid settings and cannot configure another user without a binding', async () => {
  await bind();
  await expect(
    configureCanvasReminder('canvas', 'alice', { enabled: true, days: 0 }),
  ).rejects.toThrow();
  await expect(
    configureCanvasReminder('canvas', 'bob', { enabled: true, days: 7 }),
  ).rejects.toThrow();
  await expect(
    configureCanvasReminder('canvas', 'alice', {
      enabled: true,
      days: 7,
      manualExpiresAt: 'nonsense',
    }),
  ).rejects.toThrow();
});

test('never interprets an account email as a recipient list', async () => {
  await bind();
  await enable();
  findUser.mockResolvedValue({ username: 'alice', email: 'alice@example.com,bob@example.com' });
  await runCanvasReminders();
  expect(sendMail).not.toHaveBeenCalled();
});

test('SMTP rejection is not recorded as successful delivery', async () => {
  await bind();
  await enable();
  sendMail.mockResolvedValue({ accepted: [], rejected: ['alice@example.com'] });
  await runCanvasReminders();
  expect(await status()).toMatchObject({ delivery: 'failed' });
});
