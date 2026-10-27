import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { getSettingsPath } from '../config/index.js';
import { getCredentialBindingDao, getServerDao } from '../dao/DaoFactory.js';
import { expandServerConfig } from './serverConfigEnvironment.js';
import { RequestContextService } from './requestContextService.js';
import { getT } from '../utils/i18n.js';
import { logger } from '../utils/logger.js';
import type { ServerConfig, StoredCredentialBinding } from '../types/index.js';
import {
  CredentialBindingConfigError,
  CredentialBindingError,
  MissingCredentialError,
  StaleCredentialError,
  hasCredentialTemplate,
  isCredentialValueAllowed,
  resolveCredentialUrl,
  argumentCredentialBindings,
  resolvedCredentialValues,
  credentialSlotId,
  validateCredentialTemplate,
} from '../utils/credentialTemplate.js';
import { ORPHANED_FINGERPRINT, canonicalCredentialDestination } from '../utils/credentialDestination.js';
import { isWorkspaceEnabled } from './userServerSelectionService.js';

export const credentialBindingEvents = new EventEmitter();

const parseEncryptionKey = (encoded: string): Buffer => {
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new CredentialBindingConfigError(
      'Invalid encryption key: MCPHUB_CREDENTIAL_ENCRYPTION_KEY or its local key file must contain 32 random bytes, base64 encoded',
    );
  }
  return key;
};

const encryptionKey = async (allowCreate = false): Promise<Buffer> => {
  const configured = process.env.MCPHUB_CREDENTIAL_ENCRYPTION_KEY;
  if (configured !== undefined) return parseEncryptionKey(configured);
  const file = `${getSettingsPath()}.credentials.key`;
  const readKey = (): Buffer | undefined => {
    try {
      return parseEncryptionKey(fs.readFileSync(file, 'utf8').trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      if (error instanceof CredentialBindingError) throw error;
      throw new CredentialBindingConfigError(
        'Unable to read the personal credential encryption key file',
      );
    }
  };
  const existing = readKey();
  if (existing) return existing;
  const missing = () =>
    new CredentialBindingConfigError(
      'Personal credential encryption key is missing. Restore the key file or MCPHUB_CREDENTIAL_ENCRYPTION_KEY before using existing bindings',
    );
  if (!allowCreate) throw missing();
  const hasBindings = await getCredentialBindingDao().hasBindings();
  // Another process may have created the key while storage was being checked.
  const createdElsewhere = readKey();
  if (createdElsewhere) return createdElsewhere;
  if (hasBindings) throw missing();

  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(temporary, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    try {
      // Publish a complete key atomically without replacing a concurrent creator's key.
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const key = readKey();
    if (!key) throw missing();
    return key;
  } catch (error) {
    if (error instanceof CredentialBindingError) throw error;
    throw new CredentialBindingConfigError(
      'Unable to persist the personal credential encryption key. Make the settings directory writable or configure MCPHUB_CREDENTIAL_ENCRYPTION_KEY',
    );
  } finally {
    fs.rmSync(temporary, { force: true });
  }
};

const bindingIdentity = (serverName: string, username: string): Buffer =>
  Buffer.from(JSON.stringify([serverName, username]));

export const encryptCredentialValues = async (
  serverName: string,
  username: string,
  values: Record<string, string>,
): Promise<string> => {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await encryptionKey(true), iv);
  cipher.setAAD(bindingIdentity(serverName, username));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
};

export const decryptCredentialValues = async (
  binding: StoredCredentialBinding,
): Promise<Record<string, string>> => {
  const key = await encryptionKey();
  try {
    const [version, iv, tag, ciphertext] = binding.encryptedValues.split('.');
    if (version !== 'v1') throw new Error('Unsupported version');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(bindingIdentity(binding.serverName, binding.username));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    );
  } catch {
    throw new CredentialBindingConfigError(
      'Unable to unlock personal credentials; ask an administrator to check the encryption key or replace your binding',
    );
  }
};

const requestLanguage = (): string | undefined => {
  const context = RequestContextService.getInstance();
  const configured = context.getHeader('x-language') ?? context.getHeader('accept-language');
  const language = Array.isArray(configured) ? configured[0] : configured;
  return language?.split(',')[0].split(';')[0].trim() || undefined;
};

const defaultMissingCredentialMessage = (serverName: string): string =>
  `Personal credentials required for '${serverName}'. Bind all required slots in Dashboard → Credentials.`;

export const missingCredentialError = (serverName: string): CredentialBindingError => {
  const workspace = isWorkspaceEnabled();
  const fallback = workspace
    ? `Personal credentials required for '${serverName}'. Add them from your workspace.`
    : defaultMissingCredentialMessage(serverName);
  const message = getT(requestLanguage())(workspace ? 'credentials.missingWorkspace' : 'credentials.missing', {
    serverName,
    defaultValue: fallback,
  });
  return new MissingCredentialError(message || fallback);
};

// The user's values were entered for a different destination than the server now declares.
export const staleCredentialError = (serverName: string): CredentialBindingError => {
  const workspace = isWorkspaceEnabled();
  const fallback = workspace
    ? `The connection settings of '${serverName}' changed. Enter your credentials again from your workspace.`
    : `The connection settings of '${serverName}' changed. Enter your personal credentials again in Dashboard → Credentials.`;
  const message = getT(requestLanguage())(
    workspace ? 'credentials.changedWorkspace' : 'credentials.changed',
    { serverName, defaultValue: fallback },
  );
  return new StaleCredentialError(message || fallback);
};

const FINGERPRINT_VERSION = 'v1';

// The one canonical form of a server's destination: the stored definition, expanded exactly
// as the runtime expands it (`expandServerConfig`, always), then reduced to the
// destination-relevant fields. Save, status, resolution, the startup stamping and the
// administrator's before/after comparison all go through it, so they cannot disagree.
export const canonicalDestination = async (definition: ServerConfig): Promise<string> =>
  canonicalCredentialDestination(await expandServerConfig(definition));

// Keyed with the credential encryption key so the stored value reveals nothing about the
// declaration (URLs, header values and env can carry secrets) and cannot be recomputed
// without the key. Changing the key therefore also invalidates the bindings (they could not
// be decrypted with it either).
const keyedFingerprint = async (canonical: string): Promise<string> =>
  `${FINGERPRINT_VERSION}:${createHmac('sha256', await encryptionKey(true))
    .update(`mcphub:credential-destination:${FINGERPRINT_VERSION}\0`)
    .update(canonical)
    .digest('hex')}`;

export const computeDestinationFingerprint = async (definition: ServerConfig): Promise<string> =>
  keyedFingerprint(await canonicalDestination(definition));

// A binding is valid only for the exact fingerprint it was saved with. One without a
// fingerprint (never stamped) or marked orphaned is stale.
const isStaleBinding = (binding: StoredCredentialBinding, current: string): boolean =>
  binding.destinationFingerprint !== current;

export const getCredentialBindingStatus = async (
  serverName: string,
  username: string,
  definition: ServerConfig,
) => {
  const binding = await getCredentialBindingDao().get(serverName, username);
  const slots = validateCredentialTemplate(definition) || [];
  const values = binding ? await decryptCredentialValues(binding) : {};
  if (binding && isStaleBinding(binding, await computeDestinationFingerprint(definition)))
    return { configured: false, configuredSlots: [], updatedAt: binding.updatedAt, stale: true };
  const configuredSlots = slots
    .filter((slot) => isCredentialValueAllowed(slot, values[credentialSlotId(slot)]))
    .map(credentialSlotId);
  return {
    configured: slots.length > 0 && configuredSlots.length === slots.length,
    configuredSlots,
    updatedAt: binding?.updatedAt ?? null,
  };
};

export const saveCredentialBinding = async (
  serverName: string,
  username: string,
  definition: ServerConfig,
  values: unknown,
): Promise<void> => {
  const slots = validateCredentialTemplate(definition) || [];
  if (!slots.length)
    throw new CredentialBindingError('This server has no per-user credential slots');
  if (!values || typeof values !== 'object' || Array.isArray(values))
    throw new CredentialBindingError('Provide values for all declared credential slots');
  const record = values as Record<string, unknown>;
  const ids = slots.map(credentialSlotId);
  if (
    Object.keys(record).some((id) => !ids.includes(id)) ||
    ids.some(
      (id) =>
        typeof record[id] !== 'string' ||
        !(record[id] as string).trim() ||
        (record[id] as string).length > 16384 ||
        (record[id] as string).includes('\0') ||
        (id.startsWith('headers.') && /[\r\n]/.test(record[id] as string)),
    )
  )
    throw new CredentialBindingError(
      'Provide a non-empty value for every declared slot; undeclared slots and invalid header values are not allowed',
    );
  if (slots.some((slot) => !isCredentialValueAllowed(slot, record[credentialSlotId(slot)])))
    throw new CredentialBindingError('Invalid URL credential binding');
  const encryptedValues = await encryptCredentialValues(
    serverName,
    username,
    record as Record<string, string>,
  );
  await getCredentialBindingDao().save({
    serverName,
    username,
    encryptedValues,
    updatedAt: new Date().toISOString(),
    destinationFingerprint: await computeDestinationFingerprint(definition),
  });
  credentialBindingEvents.emit('invalidate', { serverName, username });
};

export const deleteCredentialBindings = async (filter: {
  serverName?: string;
  username?: string;
}): Promise<void> => {
  await getCredentialBindingDao().delete(filter);
  credentialBindingEvents.emit('invalidate', filter);
};

// Copies every binding of a server being renamed to the new name. The server
// name is part of the ciphertext's associated data, so each binding is
// re-encrypted rather than moved. The originals stay until the caller deletes
// them after the rename has succeeded. All bindings are decrypted before the
// first write: if one cannot be (missing, unreadable or wrong key, damaged
// row), nothing is written and the rename fails, so a recoverable binding is
// never discarded. A failed save removes the copies already written.
export const copyCredentialBindings = async (oldName: string, newName: string): Promise<void> => {
  const dao = getCredentialBindingDao();
  const copies: StoredCredentialBinding[] = [];
  for (const username of await dao.listUsernames(oldName)) {
    const binding = await dao.get(oldName, username);
    if (!binding) continue;
    let values: Record<string, string>;
    try {
      values = await decryptCredentialValues(binding);
    } catch (error) {
      throw new CredentialBindingError(
        `Cannot rename '${oldName}': the credential binding of user '${username}' cannot be decrypted (${error instanceof Error ? error.message : String(error)}). Restore the encryption key, or have the user replace or delete that binding, then rename again`,
      );
    }
    copies.push({
      ...binding,
      serverName: newName,
      encryptedValues: await encryptCredentialValues(newName, username, values),
    });
  }
  try {
    for (const copy of copies) await dao.save(copy);
  } catch (error) {
    await deleteCredentialBindings({ serverName: newName }).catch((cleanupError) =>
      logger.error('Failed to remove partial credential binding copies after a failed rename', {
        serverName: oldName,
        newName,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      }),
    );
    throw error;
  }
  credentialBindingEvents.emit('invalidate', { serverName: newName });
};

export const resolveCredentialBinding = async (
  serverName: string,
  username: string,
  definition: ServerConfig,
) => {
  // Expanded once, here: the fingerprint and the runtime config come from the same value.
  const config = await expandServerConfig(definition);
  const slots = validateCredentialTemplate(config) || [];
  const binding = await getCredentialBindingDao().get(serverName, username);
  if (!binding) throw missingCredentialError(serverName);
  const values = await decryptCredentialValues(binding);
  // Checked before any value is read into the config: a binding made for another
  // destination is treated as missing and its values are never injected.
  const fingerprint = await keyedFingerprint(canonicalCredentialDestination(config));
  if (isStaleBinding(binding, fingerprint)) throw staleCredentialError(serverName);
  const resolved: ServerConfig = {
    ...config,
    url: resolveCredentialUrl(config, values),
    env: { ...config.env },
    headers: { ...config.headers },
  };
  const argumentValues: Record<string, string> = Object.create(null);
  for (const slot of slots) {
    const value = values[credentialSlotId(slot)];
    if (typeof value !== 'string' || !value.length) throw missingCredentialError(serverName);
    if (slot.target === 'url') continue;
    if (slot.target === 'args') {
      argumentValues[slot.name] = value;
      continue;
    }
    if (slot.target === 'headers') {
      for (const name of Object.keys(resolved.headers!)) {
        if (name.toLowerCase() === slot.name.toLowerCase()) delete resolved.headers![name];
      }
    }
    resolved[slot.target]![slot.name] = value;
  }
  argumentCredentialBindings.set(resolved, argumentValues);
  resolvedCredentialValues.set(
    resolved,
    slots
      .map((slot) => values[credentialSlotId(slot)])
      .filter((value) => typeof value === 'string'),
  );
  // Caller-supplied passthrough headers must never override a bound slot.
  const boundHeaders = new Set(
    slots.filter((slot) => slot.target === 'headers').map((slot) => slot.name.toLowerCase()),
  );
  resolved.passthroughHeaders = config.passthroughHeaders?.filter(
    (name) => !boundHeaders.has(name.toLowerCase()),
  );
  if (config.openapi)
    resolved.openapi = {
      ...config.openapi,
      passthroughHeaders: config.openapi.passthroughHeaders?.filter(
        (name) => !boundHeaders.has(name.toLowerCase()),
      ),
    };
  return { config: resolved, revision: binding.encryptedValues };
};

// Usernames whose binding is valid for the declaration as it stands now.
export const listValidBindingUsers = async (
  serverName: string,
  definition: ServerConfig,
): Promise<string[]> => {
  const dao = getCredentialBindingDao();
  const usernames = await dao.listUsernames(serverName);
  if (!usernames.length) return [];
  const fingerprint = await computeDestinationFingerprint(definition);
  const valid: string[] = [];
  for (const username of usernames) {
    const binding = await dao.get(serverName, username);
    if (binding && !isStaleBinding(binding, fingerprint)) valid.push(username);
  }
  return valid;
};

// One-time pass at startup, before requests are served: gives every binding that has no
// fingerprint the fingerprint of its server's current declaration, so an upgrade invalidates
// nothing, and nothing is ever adopted later on first use. A binding whose server no longer
// exists is marked orphaned (never deleted); one that cannot be decrypted is left unstamped,
// and so stale. Each stamp is a conditional write, so instances starting together cannot
// overwrite one another. Never throws: a failure is logged and the binding stays stale.
export const stampLegacyBindings = async (): Promise<{
  stamped: number;
  orphaned: number;
  skipped: number;
}> => {
  const counts = { stamped: 0, orphaned: 0, skipped: 0 };
  try {
    const dao = getCredentialBindingDao();
    const legacy = await dao.listUnstamped();
    const servers = new Map<string, (ServerConfig & { name: string }) | null>();
    for (const binding of legacy) {
      try {
        if (!servers.has(binding.serverName))
          servers.set(binding.serverName, (await getServerDao().findById(binding.serverName)) ?? null);
        const server = servers.get(binding.serverName);
        let fingerprint = ORPHANED_FINGERPRINT;
        if (server) {
          // Personal OAuth rows and servers that no longer take slots are not slot bindings.
          if (!hasCredentialTemplate(server)) {
            counts.skipped++;
            continue;
          }
          await decryptCredentialValues(binding);
          fingerprint = await computeDestinationFingerprint(server);
        }
        if (
          await dao.adoptDestinationFingerprint(
            binding.serverName,
            binding.username,
            binding.encryptedValues,
            fingerprint,
          )
        )
          counts[server ? 'stamped' : 'orphaned']++;
      } catch (error) {
        counts.skipped++;
        logger.warn('Could not stamp a personal credential binding; it will ask for new values', {
          serverName: binding.serverName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (legacy.length) logger.log('Stamped personal credential bindings with their destination', counts);
  } catch (error) {
    logger.error('Failed to stamp personal credential bindings at startup', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return counts;
};

// A server created under a name that still has bindings (left by an earlier server of that
// name) must not inherit them, whatever its declaration.
export const retireServerBindings = async (serverName: string): Promise<void> => {
  await getCredentialBindingDao().setServerFingerprint(serverName, ORPHANED_FINGERPRINT);
};
