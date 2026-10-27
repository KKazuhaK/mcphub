import { IsNull, Not, Repository } from 'typeorm';
import { BearerKey } from '../entities/BearerKey.js';
import { getAppDataSource } from '../connection.js';
import { withDbRetry, RetryOptions } from '../../utils/dbRetry.js';

// Default retry options
const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  jitter: true,
};

/**
 * Repository for BearerKey entity with automatic retry logic
 */
export class BearerKeyRepository {
  private get repository(): Repository<BearerKey> {
    return getAppDataSource().getRepository(BearerKey);
  }
  private retryOptions: RetryOptions;

  constructor(retryOptions?: RetryOptions) {
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...retryOptions };
  }

  /**
   * Execute an operation with retry logic
   */
  private async withRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
    return withDbRetry(operation, {
      ...this.retryOptions,
      operationName: `BearerKeyRepository.${operationName}`,
    });
  }

  /**
   * Find all bearer keys
   */
  async findAll(): Promise<BearerKey[]> {
    return this.withRetry(() => this.repository.find({ order: { createdAt: 'ASC' } }), 'findAll');
  }

  /**
   * Count bearer keys
   */
  async count(): Promise<number> {
    return this.withRetry(() => this.repository.count(), 'count');
  }

  /**
   * Find bearer key by id
   */
  async findById(id: string): Promise<BearerKey | null> {
    return this.withRetry(() => this.repository.findOne({ where: { id } }), 'findById');
  }

  /**
   * Find bearer key by the SHA-256 of its token
   */
  async findByTokenHash(tokenHash: string): Promise<BearerKey | null> {
    return this.withRetry(
      () => this.repository.findOne({ where: { tokenHash } }),
      'findByTokenHash',
    );
  }

  /**
   * Rows still holding a plaintext token from an older version.
   */
  async findWithPlaintextToken(): Promise<BearerKey[]> {
    return this.withRetry(
      () => this.repository.find({ where: { token: Not(IsNull()) } }),
      'findWithPlaintextToken',
    );
  }

  /**
   * Replace a plaintext token with its hash. Conditional on the plaintext still being there,
   * so a concurrent instance that already migrated the row is not overwritten.
   */
  async replacePlaintextToken(
    id: string,
    plaintext: string,
    tokenHash: string,
    tokenPrefix: string,
  ): Promise<boolean> {
    return this.withRetry(async () => {
      const result = await this.repository.update(
        { id, token: plaintext },
        { token: null, tokenHash, tokenPrefix },
      );
      return (result.affected ?? 0) > 0;
    }, 'replacePlaintextToken');
  }

  async findByOwner(owner: string): Promise<BearerKey[]> {
    return this.withRetry(
      () => this.repository.find({ where: { kind: 'user', owner }, order: { createdAt: 'ASC' } }),
      'findByOwner',
    );
  }

  /**
   * Create a new bearer key
   */
  async create(data: Omit<BearerKey, 'id' | 'createdAt' | 'updatedAt'>): Promise<BearerKey> {
    return this.withRetry(async () => {
      const entity = this.repository.create(data);
      return await this.repository.save(entity);
    }, 'create');
  }

  /**
   * Stamp last use with a targeted UPDATE ... WHERE id: a key deleted meanwhile stays gone
   * and a concurrent change to another column (such as enabled) is not overwritten.
   */
  async recordLastUsed(id: string, at: Date): Promise<boolean> {
    return this.withRetry(async () => {
      const result = await this.repository.update({ id }, { lastUsedAt: at });
      return (result.affected ?? 0) > 0;
    }, 'recordLastUsed');
  }

  /**
   * Update an existing bearer key
   */
  async update(
    id: string,
    updates: Partial<Omit<BearerKey, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<BearerKey | null> {
    return this.withRetry(async () => {
      const existing = await this.findById(id);
      if (!existing) {
        return null;
      }
      const merged = this.repository.merge(existing, updates);
      return await this.repository.save(merged);
    }, 'update');
  }

  /**
   * Delete a bearer key
   */
  async delete(id: string): Promise<boolean> {
    return this.withRetry(async () => {
      const result = await this.repository.delete({ id });
      return (result.affected ?? 0) > 0;
    }, 'delete');
  }

  async deleteByOwner(owner: string): Promise<number> {
    return this.withRetry(async () => {
      const result = await this.repository.delete({ kind: 'user', owner });
      return result.affected ?? 0;
    }, 'deleteByOwner');
  }
}

export default BearerKeyRepository;
