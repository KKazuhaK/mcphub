import { IActivity, IActivityFilter, IActivityStats } from '../types/index.js';
import { PaginatedResult } from './index.js';
import {
  ActivityRepository,
  type ActivityHistoryQuery,
  type ActivityHistoryRow,
} from '../db/repositories/ActivityRepository.js';

export type { ActivityHistoryQuery, ActivityHistoryRow };

/**
 * Activity DAO interface - only available in database mode
 */
export interface ActivityDao {
  create(activity: Omit<IActivity, 'id'>): Promise<IActivity>;
  findById(id: string): Promise<IActivity | null>;
  findPaginated(
    page: number,
    limit: number,
    filter?: IActivityFilter,
  ): Promise<PaginatedResult<IActivity>>;
  getStats(filter?: IActivityFilter): Promise<IActivityStats>;
  deleteOlderThan(date: Date): Promise<number>;
  /** One user's rows, newest first, as metadata only (payload columns are never selected). */
  findUserHistory(query: ActivityHistoryQuery): Promise<ActivityHistoryRow[]>;
  /**
   * Deletes rows older than `date` in batches until none are left or the time budget is spent.
   * `done` is false when a backlog remains for the next run.
   */
  purgeOlderThan(
    date: Date,
    options?: { batchSize?: number; budgetMs?: number },
  ): Promise<{ removed: number; done: boolean }>;
  getDistinctServers(): Promise<string[]>;
  getDistinctTools(): Promise<string[]>;
  getDistinctGroups(): Promise<string[]>;
  getDistinctUsernames(): Promise<string[]>;
  getDistinctKeyNames(): Promise<string[]>;
}

/**
 * Database implementation of ActivityDao
 * Activity logging is only available in database mode
 */
export class ActivityDaoDbImpl implements ActivityDao {
  private repository: ActivityRepository;

  constructor() {
    this.repository = new ActivityRepository();
  }

  async create(activity: Omit<IActivity, 'id'>): Promise<IActivity> {
    const created = await this.repository.create({
      timestamp: activity.timestamp,
      server: activity.server,
      tool: activity.tool,
      duration: activity.duration,
      status: activity.status,
      input: activity.input,
      output: activity.output,
      group: activity.group,
      username: activity.username,
      keyId: activity.keyId,
      keyName: activity.keyName,
      sourceIp: activity.sourceIp,
      errorMessage: activity.errorMessage,
      statusCode: activity.statusCode ?? null,
      clientKind: activity.clientKind ?? null,
      clientId: activity.clientId ?? null,
    });

    return this.mapToActivity(created);
  }

  async findById(id: string): Promise<IActivity | null> {
    const activity = await this.repository.findById(id);
    return activity ? this.mapToActivity(activity) : null;
  }

  async findPaginated(
    page: number,
    limit: number,
    filter?: IActivityFilter,
  ): Promise<PaginatedResult<IActivity>> {
    const { data, total } = await this.repository.findPaginated(page, limit, filter);
    const totalPages = Math.ceil(total / limit);

    return {
      data: data.map((a) => this.mapToActivity(a)),
      total,
      page,
      limit,
      totalPages,
    };
  }

  async getStats(filter?: IActivityFilter): Promise<IActivityStats> {
    return await this.repository.getStats(filter);
  }

  async deleteOlderThan(date: Date): Promise<number> {
    return await this.repository.deleteOlderThan(date);
  }

  async findUserHistory(query: ActivityHistoryQuery): Promise<ActivityHistoryRow[]> {
    return await this.repository.findUserHistory(query);
  }

  async purgeOlderThan(
    date: Date,
    options?: { batchSize?: number; budgetMs?: number },
  ): Promise<{ removed: number; done: boolean }> {
    return await this.repository.purgeOlderThan(date, options);
  }

  async getDistinctServers(): Promise<string[]> {
    return await this.repository.getDistinctServers();
  }

  async getDistinctTools(): Promise<string[]> {
    return await this.repository.getDistinctTools();
  }

  async getDistinctGroups(): Promise<string[]> {
    return await this.repository.getDistinctGroups();
  }

  async getDistinctUsernames(): Promise<string[]> {
    return await this.repository.getDistinctUsernames();
  }

  async getDistinctKeyNames(): Promise<string[]> {
    return await this.repository.getDistinctKeyNames();
  }

  private mapToActivity(entity: any): IActivity {
    return {
      id: entity.id,
      timestamp: entity.timestamp,
      server: entity.server,
      tool: entity.tool,
      duration: entity.duration,
      status: entity.status as 'success' | 'error',
      input: entity.input,
      output: entity.output,
      group: entity.group,
      username: entity.username,
      keyId: entity.keyId,
      keyName: entity.keyName,
      sourceIp: entity.sourceIp,
      errorMessage: entity.errorMessage,
      statusCode: entity.statusCode ?? null,
      clientKind: entity.clientKind ?? null,
      clientId: entity.clientId ?? null,
    };
  }
}
