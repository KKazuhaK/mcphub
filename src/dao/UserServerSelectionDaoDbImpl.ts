import { getAppDataSource } from '../db/connection.js';
import { UserServerSelectionRecord } from '../db/entities/UserServerSelectionRecord.js';
import type { UserServerSelection } from '../types/index.js';
import type { UserServerSelectionDao } from './UserServerSelectionDao.js';

export class UserServerSelectionDaoDbImpl implements UserServerSelectionDao {
  private get repository() {
    return getAppDataSource().getRepository(UserServerSelectionRecord);
  }

  async listByUsername(username: string): Promise<UserServerSelection[]> {
    return this.repository.findBy({ username });
  }

  async save(selection: UserServerSelection): Promise<void> {
    await this.repository.upsert(selection, ['serverName', 'username']);
  }

  async delete(filter: { serverName?: string; username?: string }): Promise<boolean> {
    if (filter.serverName === undefined && filter.username === undefined) return false;
    const result = await this.repository.delete(filter);
    return (result.affected ?? 0) > 0;
  }

  async renameServer(oldName: string, newName: string): Promise<boolean> {
    const removed = await this.repository.delete({ serverName: newName });
    const moved = await this.repository.update({ serverName: oldName }, { serverName: newName });
    return (removed.affected ?? 0) > 0 || (moved.affected ?? 0) > 0;
  }
}
