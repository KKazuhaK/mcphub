import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { getCredentialBindingDao, getServerDao, getUserDao } from '../dao/DaoFactory.js';
import { authorizationService } from './authorizationService.js';
import { decryptCredentialValues, encryptCredentialValues } from './credentialBindingService.js';
import {
  CANVAS_METADATA,
  isCanvasBinding,
  readCanvasReminder,
  type CanvasReminder,
} from './canvasCredentialMetadata.js';
import { discoverCanvasExpiry } from './canvasExpiryService.js';
import { CredentialBindingError } from '../utils/credentialTemplate.js';
import { logger } from '../utils/logger.js';
import type { StoredCredentialBinding } from '../types/index.js';

const persist = async (
  binding: StoredCredentialBinding,
  values: Record<string, string>,
  state: CanvasReminder,
) =>
  getCredentialBindingDao().compareAndSave(
    {
      ...binding,
      encryptedValues: await encryptCredentialValues(binding.serverName, binding.username, {
        ...values,
        [CANVAS_METADATA]: JSON.stringify(state),
      }),
    },
    binding.encryptedValues,
  );

export const configureCanvasReminder = async (
  serverName: string,
  username: string,
  input: unknown,
): Promise<void> => {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new CredentialBindingError('Invalid reminder settings');
  const data = input as Record<string, unknown>;
  if (
    typeof data.enabled !== 'boolean' ||
    !Number.isInteger(data.days) ||
    Number(data.days) < 1 ||
    Number(data.days) > 90
  ) {
    throw new CredentialBindingError('Reminder days must be an integer from 1 to 90');
  }
  const binding = await getCredentialBindingDao().get(serverName, username);
  if (!binding) throw new CredentialBindingError('Bind your Canvas credentials first');
  const values = await decryptCredentialValues(binding);
  if (!isCanvasBinding(values))
    throw new CredentialBindingError('This binding has no Canvas credentials');
  const previous = readCanvasReminder(values);
  let state: CanvasReminder = { ...previous, enabled: data.enabled, days: Number(data.days) };
  if ('manualExpiresAt' in data) {
    const expiry =
      typeof data.manualExpiresAt === 'string' ? Date.parse(data.manualExpiresAt) : NaN;
    if (!Number.isFinite(expiry) || expiry <= 0 || expiry > Date.parse('2100-01-01T00:00:00Z')) {
      throw new CredentialBindingError('Provide a valid expiration date');
    }
    state = { ...state, source: 'manual', expiresAt: new Date(expiry).toISOString() };
  }
  if (data.refresh === true) {
    const discovered = await discoverCanvasExpiry(values);
    if (discovered.source === 'canvas' || state.source === 'unknown')
      state = { ...state, ...discovered };
    state.checkedAt = new Date().toISOString();
  }
  if (state.expiresAt !== previous.expiresAt || state.source !== previous.source) {
    state.notified = [];
    delete state.lease;
    delete state.delivery;
  }
  if (!(await persist(binding, values, state)))
    throw new CredentialBindingError('Credentials changed; reload and try again');
};

export const reminderStage = (state: CanvasReminder, now: number): string | undefined => {
  if (!state.enabled || state.source === 'unknown' || !state.expiresAt) return undefined;
  const expiry = Date.parse(state.expiresAt);
  if (expiry > now + state.days * 86400000) return undefined;
  return `${state.expiresAt}:${expiry <= now ? 'expired' : 'soon'}`;
};

const sendReminder = async (
  email: string,
  serverName: string,
  state: CanvasReminder,
): Promise<void> => {
  const publicUrl = new URL(process.env.MCPHUB_PUBLIC_URL || '');
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password)
    throw new Error('Invalid public URL');
  const host = process.env.MCPHUB_SMTP_HOST;
  const from = process.env.MCPHUB_SMTP_FROM;
  if (
    !host ||
    !from ||
    /[\r\n]/.test(from + email) ||
    !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(email)
  )
    throw new Error('Missing mail configuration');
  const secure = process.env.MCPHUB_SMTP_SECURE === 'true';
  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.MCPHUB_SMTP_PORT || (secure ? 465 : 587)),
    secure,
    requireTLS: !secure,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: process.env.MCPHUB_SMTP_USER
      ? { user: process.env.MCPHUB_SMTP_USER, pass: process.env.MCPHUB_SMTP_PASSWORD }
      : undefined,
  });
  try {
    const expired = Date.parse(state.expiresAt!) <= Date.now();
    const path = `${publicUrl.pathname.replace(/\/$/, '')}/credentials?server=${encodeURIComponent(serverName)}`;
    publicUrl.pathname = path.split('?')[0];
    publicUrl.search = path.slice(path.indexOf('?'));
    const result = await transporter.sendMail({
      from,
      to: email,
      messageId: `<${randomUUID()}@${publicUrl.hostname}>`,
      subject: expired
        ? 'Canvas token expired / Canvas 凭据已到期'
        : 'Canvas token expiring soon / Canvas 凭据即将到期',
      text: `Your Canvas token for ${serverName} ${expired ? 'expired' : 'expires'} at ${state.expiresAt} (UTC).\nUpdate your personal credentials: ${publicUrl.href}\n\n你的 Canvas 凭据${expired ? '已到期' : '即将到期'}，请登录 MCPHub 更新。\nThis message contains no API token.`,
    });
    if (!result.accepted?.length) throw new Error('SMTP did not accept the reminder');
  } finally {
    transporter.close();
  }
};

let running = false;
export const runCanvasReminders = async (): Promise<void> => {
  if (running) return;
  running = true;
  try {
    const dao = getCredentialBindingDao();
    for (const server of await getServerDao().findAll()) {
      for (const username of await dao.listUsernames(server.name)) {
        try {
          const user = await getUserDao().findById(username);
          if (!user || !authorizationService.can('server.discover', server, user)) continue;
          let binding = await dao.get(server.name, username);
          if (!binding) continue;
          let values = await decryptCredentialValues(binding);
          if (!isCanvasBinding(values)) continue;
          let state = readCanvasReminder(values);
          // Backfill metadata for existing bindings without opting them into email.
          if (Date.now() - Date.parse(state.checkedAt || '1970-01-01') >= 86400000) {
            const discovered = await discoverCanvasExpiry(values);
            const before = state.expiresAt;
            if (discovered.source === 'canvas' || state.source === 'unknown')
              state = { ...state, ...discovered };
            state.checkedAt = new Date().toISOString();
            if (state.expiresAt !== before) {
              state.notified = [];
              delete state.lease;
              delete state.delivery;
            }
            if (!(await persist(binding, values, state))) continue;
            binding = await dao.get(server.name, username);
            if (!binding) continue;
            values = await decryptCredentialValues(binding);
            state = readCanvasReminder(values);
          }
          const stage = reminderStage(state, Date.now());
          if (
            !stage ||
            state.notified?.includes(stage) ||
            !user.email ||
            !process.env.MCPHUB_SMTP_HOST ||
            !process.env.MCPHUB_SMTP_FROM ||
            !process.env.MCPHUB_PUBLIC_URL ||
            (state.lease && state.lease.until > Date.now())
          )
            continue;
          if (
            !(await persist(binding, values, {
              ...state,
              lease: { stage, until: Date.now() + 300000 },
            }))
          )
            continue;
          const claimed = await dao.get(server.name, username);
          if (!claimed) continue;
          const claimedValues = await decryptCredentialValues(claimed);
          const currentState = readCanvasReminder(claimedValues);
          if (currentState.lease?.stage !== stage || !currentState.enabled) continue;
          // Re-check deletion/rotation immediately before delivery. A crash after SMTP
          // accepts but before persistence can still duplicate a mail on the next run.
          const current = await dao.get(server.name, username);
          if (current?.encryptedValues !== claimed.encryptedValues) continue;
          try {
            await sendReminder(user.email, server.name, currentState);
            await persist(claimed, claimedValues, {
              ...currentState,
              lease: undefined,
              delivery: 'sent',
              notified: [...(currentState.notified || []), stage],
            });
          } catch {
            await persist(claimed, claimedValues, { ...currentState, delivery: 'failed' });
            logger.warn('Canvas reminder delivery failed');
          }
        } catch {
          logger.warn('Canvas reminder binding check failed');
        }
      }
    }
  } finally {
    running = false;
  }
};
let timer: ReturnType<typeof setInterval> | undefined;
export const startCanvasReminders = (): void => {
  if (timer) return;
  const run = () => {
    void runCanvasReminders().catch(() => logger.warn('Canvas reminder pass failed'));
  };
  timer = setInterval(run, 3600000);
  timer.unref();
  run();
};
export const stopCanvasReminders = (): void => {
  if (timer) clearInterval(timer);
  timer = undefined;
};
