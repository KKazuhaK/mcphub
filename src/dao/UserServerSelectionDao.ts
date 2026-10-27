import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSettingsPath } from '../config/index.js';
import type { UserServerSelection } from '../types/index.js';

export interface UserServerSelectionDao {
  listByUsername(username: string): Promise<UserServerSelection[]>;
  save(selection: UserServerSelection): Promise<void>;
  /** Resolves true when at least one row was removed; a no-op never touches storage. */
  delete(filter: { serverName?: string; username?: string }): Promise<boolean>;
  /**
   * Moves every user's selection of a server to its new name, replacing stale rows already
   * under the new name. Resolves true when any row changed.
   */
  renameServer(oldName: string, newName: string): Promise<boolean>;
}

// Kept outside settings/config exports, next to the settings file.
export class UserServerSelectionDaoImpl implements UserServerSelectionDao {
  readAll(): UserServerSelection[] {
    try {
      const selections = JSON.parse(
        fs.readFileSync(`${getSettingsPath()}.selections.json`, 'utf8'),
      );
      if (!Array.isArray(selections)) throw new Error('Invalid server selection store');
      return selections;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private write(selections: UserServerSelection[]): void {
    const file = `${getSettingsPath()}.selections.json`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(selections), { flag: 'wx' });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  async listByUsername(username: string): Promise<UserServerSelection[]> {
    return this.readAll().filter((item) => item.username === username);
  }

  async save(selection: UserServerSelection): Promise<void> {
    const selections = this.readAll().filter(
      (item) => item.serverName !== selection.serverName || item.username !== selection.username,
    );
    this.write([...selections, selection]);
  }

  async delete(filter: { serverName?: string; username?: string }): Promise<boolean> {
    if (filter.serverName === undefined && filter.username === undefined) return false;
    const rows = this.readAll();
    const kept = rows.filter(
      (item) =>
        (filter.serverName !== undefined && item.serverName !== filter.serverName) ||
        (filter.username !== undefined && item.username !== filter.username),
    );
    if (kept.length === rows.length) return false;
    this.write(kept);
    return true;
  }

  async renameServer(oldName: string, newName: string): Promise<boolean> {
    const rows = this.readAll();
    if (!rows.some((item) => item.serverName === oldName || item.serverName === newName)) {
      return false;
    }
    this.write(
      rows
        .filter((item) => item.serverName !== newName)
        .map((item) => (item.serverName === oldName ? { ...item, serverName: newName } : item)),
    );
    return true;
  }
}
