import { Repository, Between, Like, FindOptionsWhere, Brackets, LessThan } from 'typeorm';
import { Activity } from '../entities/Activity.js';
import { getAppDataSource } from '../connection.js';
import { IActivityFilter, IActivityStats } from '../../types/index.js';

/** The columns a user's own history may read. Tool input and output are never selected. */
export type ActivityHistoryRow = Pick<
  Activity,
  | 'id'
  | 'timestamp'
  | 'server'
  | 'tool'
  | 'duration'
  | 'status'
  | 'errorMessage'
  | 'statusCode'
  | 'clientKind'
  | 'clientId'
>;

export interface ActivityHistoryQuery {
  username: string;
  limit: number;
  server?: string;
  clientId?: string;
  clientKind?: string;
  /** 'blocked' rows are errors whose `statusCode` is one of `blockedReasons`. */
  status?: 'success' | 'error' | 'blocked';
  blockedReasons?: string[];
  since?: Date;
  until?: Date;
  /** Keyset position of the last row already returned. */
  after?: { timestamp: Date; id: string };
}

/**
 * Repository for Activity entity
 */
export class ActivityRepository {
  private get repository(): Repository<Activity> {
    return getAppDataSource().getRepository(Activity);
  }

  /**
   * Create a new activity record
   */
  async create(activity: Omit<Activity, 'id'>): Promise<Activity> {
    const newActivity = this.repository.create(activity);
    return await this.repository.save(newActivity);
  }

  /**
   * Find activity by ID
   */
  async findById(id: string): Promise<Activity | null> {
    return await this.repository.findOne({ where: { id } });
  }

  /**
   * Build where clause from filter
   */
  private buildWhereClause(filter?: IActivityFilter): FindOptionsWhere<Activity> {
    const where: FindOptionsWhere<Activity> = {};

    if (filter?.server) {
      where.server = Like(`%${filter.server}%`);
    }
    if (filter?.tool) {
      where.tool = Like(`%${filter.tool}%`);
    }
    if (filter?.status) {
      where.status = filter.status;
    }
    if (filter?.group) {
      where.group = Like(`%${filter.group}%`);
    }
    if (filter?.username) {
      where.username = Like(`%${filter.username}%`);
    }
    if (filter?.keyId) {
      where.keyId = filter.keyId;
    }
    if (filter?.keyName) {
      where.keyName = Like(`%${filter.keyName}%`);
    }
    if (filter?.startDate && filter?.endDate) {
      where.timestamp = Between(filter.startDate, filter.endDate);
    }

    return where;
  }

  /**
   * Find activities with pagination and filtering
   */
  async findPaginated(
    page: number,
    limit: number,
    filter?: IActivityFilter,
  ): Promise<{ data: Activity[]; total: number }> {
    const skip = (page - 1) * limit;
    const where = this.buildWhereClause(filter);

    const [data, total] = await this.repository.findAndCount({
      where,
      order: { timestamp: 'DESC' },
      skip,
      take: limit,
    });

    return { data, total };
  }

  /**
   * Get activity statistics
   */
  async getStats(filter?: IActivityFilter): Promise<IActivityStats> {
    const where = this.buildWhereClause(filter);

    // Get total count
    const totalCalls = await this.repository.count({ where });

    // Get success count
    const successWhere = { ...where, status: 'success' };
    const successCount = await this.repository.count({ where: successWhere });

    // Get error count
    const errorWhere = { ...where, status: 'error' };
    const errorCount = await this.repository.count({ where: errorWhere });

    // Get average duration using query builder for more complex aggregation
    let avgDuration = 0;
    if (totalCalls > 0) {
      const qb = this.repository.createQueryBuilder('activity');

      // Apply filters to query builder
      if (filter?.server) {
        qb.andWhere('activity.server LIKE :server', { server: `%${filter.server}%` });
      }
      if (filter?.tool) {
        qb.andWhere('activity.tool LIKE :tool', { tool: `%${filter.tool}%` });
      }
      if (filter?.status) {
        qb.andWhere('activity.status = :status', { status: filter.status });
      }
      if (filter?.group) {
        qb.andWhere('activity.group_name LIKE :group', { group: `%${filter.group}%` });
      }
      if (filter?.username) {
        qb.andWhere('activity.username LIKE :username', { username: `%${filter.username}%` });
      }
      if (filter?.keyId) {
        qb.andWhere('activity.key_id = :keyId', { keyId: filter.keyId });
      }
      if (filter?.keyName) {
        qb.andWhere('activity.key_name LIKE :keyName', { keyName: `%${filter.keyName}%` });
      }
      if (filter?.startDate && filter?.endDate) {
        qb.andWhere('activity.timestamp BETWEEN :startDate AND :endDate', {
          startDate: filter.startDate,
          endDate: filter.endDate,
        });
      }

      const result = await qb.select('AVG(activity.duration)', 'avgDuration').getRawOne();

      avgDuration = Math.round(parseFloat(result?.avgDuration || '0'));
    }

    return {
      totalCalls,
      successCount,
      errorCount,
      avgDuration,
    };
  }

  /**
   * Delete activities older than specified date
   */
  async deleteOlderThan(date: Date): Promise<number> {
    const result = await this.repository
      .createQueryBuilder()
      .delete()
      .where('timestamp < :date', { date })
      .execute();

    return result.affected || 0;
  }

  /**
   * One user's history, newest first (timestamp, then id), `limit` rows. Reads metadata columns
   * only. Callers ask for one more than they show to learn whether another page exists.
   */
  async findUserHistory(query: ActivityHistoryQuery): Promise<ActivityHistoryRow[]> {
    const qb = this.repository
      .createQueryBuilder('a')
      .select([
        'a.id',
        'a.timestamp',
        'a.server',
        'a.tool',
        'a.duration',
        'a.status',
        'a.errorMessage',
        'a.statusCode',
        'a.clientKind',
        'a.clientId',
      ])
      .where('a.username = :username', { username: query.username });

    if (query.server) qb.andWhere('a.server = :server', { server: query.server });
    if (query.clientId) qb.andWhere('a.clientId = :clientId', { clientId: query.clientId });
    if (query.clientKind)
      qb.andWhere('a.clientKind = :clientKind', { clientKind: query.clientKind });
    if (query.since) qb.andWhere('a.timestamp >= :since', { since: query.since });
    if (query.until) qb.andWhere('a.timestamp <= :until', { until: query.until });

    if (query.status) {
      const codes = query.blockedReasons ?? [];
      if (query.status === 'success') {
        qb.andWhere('a.status = :status', { status: 'success' });
      } else if (query.status === 'blocked') {
        qb.andWhere('a.status = :status', { status: 'error' });
        if (codes.length)
          qb.andWhere('a.statusCode IN (:...blockedCodes)', { blockedCodes: codes });
        else qb.andWhere('1 = 0');
      } else {
        qb.andWhere('a.status = :status', { status: 'error' });
        if (codes.length) {
          qb.andWhere('(a.statusCode IS NULL OR a.statusCode NOT IN (:...blockedCodes))', {
            blockedCodes: codes,
          });
        }
      }
    }

    if (query.after) {
      qb.andWhere(
        new Brackets((inner) => {
          inner
            .where('a.timestamp < :afterTs', { afterTs: query.after!.timestamp })
            .orWhere('(a.timestamp = :afterTs AND a.id < :afterId)', {
              afterId: query.after!.id,
            });
        }),
      );
    }

    return await qb
      .orderBy('a.timestamp', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .take(query.limit)
      .getMany();
  }

  /**
   * Delete rows older than `date`: ids are read in batches and removed by id, so no single
   * statement holds a long lock. Stops when nothing is left or `budgetMs` is spent; `done` is
   * false when a backlog remains.
   */
  async purgeOlderThan(
    date: Date,
    options: { batchSize?: number; budgetMs?: number; now?: () => number } = {},
  ): Promise<{ removed: number; done: boolean }> {
    const batchSize = options.batchSize ?? 1000;
    const budgetMs = options.budgetMs ?? 20_000;
    const now = options.now ?? Date.now;
    const deadline = now() + budgetMs;
    let removed = 0;
    for (;;) {
      const rows = await this.repository.find({
        select: { id: true },
        where: { timestamp: LessThan(date) },
        order: { timestamp: 'ASC' },
        take: batchSize,
      });
      if (!rows.length) return { removed, done: true };
      const result = await this.repository.delete(rows.map((row) => row.id));
      removed += result.affected ?? rows.length;
      if (rows.length < batchSize) return { removed, done: true };
      if (now() >= deadline) return { removed, done: false };
    }
  }

  /**
   * Get distinct values for filter dropdowns
   */
  async getDistinctServers(): Promise<string[]> {
    const result = await this.repository
      .createQueryBuilder('activity')
      .select('DISTINCT activity.server', 'server')
      .orderBy('activity.server', 'ASC')
      .getRawMany();

    return result.map((r) => r.server);
  }

  async getDistinctTools(): Promise<string[]> {
    const result = await this.repository
      .createQueryBuilder('activity')
      .select('DISTINCT activity.tool', 'tool')
      .orderBy('activity.tool', 'ASC')
      .getRawMany();

    return result.map((r) => r.tool);
  }

  async getDistinctGroups(): Promise<string[]> {
    const result = await this.repository
      .createQueryBuilder('activity')
      .select('DISTINCT activity.group_name', 'group')
      .where('activity.group_name IS NOT NULL')
      .orderBy('activity.group_name', 'ASC')
      .getRawMany();

    return result.map((r) => r.group);
  }

  async getDistinctUsernames(): Promise<string[]> {
    const result = await this.repository
      .createQueryBuilder('activity')
      .select('DISTINCT activity.username', 'username')
      .where('activity.username IS NOT NULL')
      .orderBy('activity.username', 'ASC')
      .getRawMany();

    return result.map((r) => r.username);
  }

  async getDistinctKeyNames(): Promise<string[]> {
    const result = await this.repository
      .createQueryBuilder('activity')
      .select('DISTINCT activity.key_name', 'keyName')
      .where('activity.key_name IS NOT NULL')
      .orderBy('activity.key_name', 'ASC')
      .getRawMany();

    return result.map((r) => r.keyName);
  }
}

export default ActivityRepository;
