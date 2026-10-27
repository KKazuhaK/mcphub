import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  Index,
  type IndexOptions,
} from 'typeorm';

/**
 * Indexes added for the per-user history. `synchronize` builds a missing index on the first boot
 * after an upgrade, which can take a while (and lock writes) on a very large table. Set
 * MCPHUB_SKIP_ACTIVITY_INDEX=true to stop synchronization from managing them: they are declared
 * with `synchronize: false`, so TypeORM neither creates nor drops them, and an index built by
 * hand under the same name is kept. Without it, history queries fall back to the `username` index.
 */
const skipHistoryIndexes = process.env.MCPHUB_SKIP_ACTIVITY_INDEX === 'true';
const ActivityHistoryIndex = (name: string, columns: string[]): ClassDecorator =>
  // TypeORM honours `synchronize: false` on an index at runtime; its typings omit the option.
  Index(name, columns, (skipHistoryIndexes ? { synchronize: false } : {}) as IndexOptions);

/**
 * Activity entity for tracking tool call history
 * Only available in database mode
 */
@Entity({ name: 'activities' })
@Index(['server'])
@Index(['tool'])
@Index(['status'])
@Index(['group'])
@Index(['username'])
@Index(['keyId'])
@Index(['timestamp'])
@ActivityHistoryIndex('IDX_activities_username_timestamp', ['username', 'timestamp'])
@ActivityHistoryIndex('IDX_activities_username_status_code', ['username', 'statusCode'])
export class Activity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'timestamp', type: 'timestamp' })
  timestamp: Date;

  @Column({ type: 'varchar', length: 255 })
  server: string;

  @Column({ type: 'varchar', length: 255 })
  tool: string;

  @Column({ type: 'int' })
  duration: number;

  @Column({ type: 'varchar', length: 20 })
  status: string; // 'success' | 'error'

  @Column({ type: 'text', nullable: true })
  input?: string;

  @Column({ type: 'text', nullable: true })
  output?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'group_name' })
  group?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'username' })
  username?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'key_id' })
  keyId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'key_name' })
  keyName?: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'source_ip' })
  sourceIp?: string;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage?: string;

  /** 'oauth' | 'key' for calls made with a connected-client credential; null otherwise. */
  /**
   * Why the call was stopped before reaching the upstream: a Server Status code (paused,
   * maintenance, ...) or an internal unavailable reason. Null for calls that ran.
   */
  @Column({ type: 'varchar', length: 40, nullable: true, name: 'status_code' })
  statusCode?: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true, name: 'client_kind' })
  clientKind?: string | null;

  /** OAuth client id or bearer key id (same identity as the connected-clients list). */
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'client_id' })
  clientId?: string | null;
}

export default Activity;
