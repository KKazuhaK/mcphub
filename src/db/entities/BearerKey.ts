import {
  Entity,
  Column,
  Index,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Bearer authentication key entity
 * Stores multiple bearer keys with per-key enable/disable and scoped access control
 */
@Entity({ name: 'bearer_keys' })
export class BearerKey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  // Plaintext written by older versions. Hashed and nulled at startup; never written again.
  @Column({ type: 'varchar', length: 512, nullable: true })
  token?: string | null;

  @Index()
  @Column({ name: 'token_hash', type: 'varchar', length: 64, nullable: true })
  tokenHash?: string | null;

  @Column({ name: 'token_prefix', type: 'varchar', length: 16, nullable: true })
  tokenPrefix?: string | null;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ type: 'varchar', length: 20, default: 'system' })
  kind: 'system' | 'user';

  @Column({ type: 'varchar', length: 255, nullable: true })
  owner?: string;

  @Column({ type: 'varchar', length: 20, default: 'all' })
  accessType: 'all' | 'groups' | 'servers' | 'custom';

  @Column({ type: 'simple-json', nullable: true })
  allowedGroups?: string[];

  @Column({ type: 'simple-json', nullable: true })
  allowedServers?: string[];

  @Column({ name: 'last_used_at', type: 'timestamp', nullable: true })
  lastUsedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp' })
  updatedAt: Date;
}

export default BearerKey;
