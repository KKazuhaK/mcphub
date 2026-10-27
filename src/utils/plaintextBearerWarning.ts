import fs from 'node:fs';
import { getSettingsPath } from '../config/index.js';
import { isDatabaseModeEnabled } from './systemConfigCache.js';
import { logger } from './logger.js';

/**
 * In database mode the settings file is only a migration source. If it still holds plaintext
 * bearer keys (`bearerKeys[].token`) or the legacy `routing.bearerAuthKey` after they have been
 * moved into the database, they sit on disk readable by anyone with the file. MCPHub does not
 * rewrite the operator's file; it says so at startup. Returns the count of plaintext secrets
 * found (0 outside database mode). Never logs a value and never throws.
 */
export const warnAboutPlaintextBearerKeysInSettingsFile = (): number => {
  if (!isDatabaseModeEnabled()) return 0;
  try {
    const path = getSettingsPath();
    if (!fs.existsSync(path)) return 0;
    const settings = JSON.parse(fs.readFileSync(path, 'utf8')) as {
      bearerKeys?: { token?: unknown }[];
      systemConfig?: { routing?: { bearerAuthKey?: unknown } };
    };
    const keys = Array.isArray(settings.bearerKeys)
      ? settings.bearerKeys.filter((key) => typeof key?.token === 'string' && key.token).length
      : 0;
    const legacy = (settings.systemConfig?.routing?.bearerAuthKey as string | undefined)?.trim()
      ? 1
      : 0;
    if (keys + legacy > 0) {
      logger.warn(
        `The settings file ${path} still contains ${keys} plaintext bearer key(s)` +
          `${legacy ? ' and a legacy routing.bearerAuthKey' : ''}. Database mode has already ` +
          'migrated them (stored hashed); remove them from the file, which MCPHub does not ' +
          'rewrite in database mode.',
      );
    }
    return keys + legacy;
  } catch {
    return 0;
  }
};
