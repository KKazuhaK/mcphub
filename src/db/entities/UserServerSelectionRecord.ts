import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'user_server_selections' })
export class UserServerSelectionRecord {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  serverName: string;

  // Selections are always read per user, which the (serverName, username) key cannot serve.
  @Index()
  @PrimaryColumn({ type: 'varchar', length: 255 })
  username: string;

  @Column({ type: 'boolean', default: false })
  selected: boolean;

  // The highest tool risk level the user allows on this server; null reads as `read`.
  @Column({ type: 'varchar', length: 16, nullable: true })
  riskCeiling?: 'read' | 'write' | 'external' | null;

  @Column({ type: 'varchar', length: 30 })
  updatedAt: string;
}
