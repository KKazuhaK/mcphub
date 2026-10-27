import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'credential_bindings' })
export class CredentialBinding {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  serverName: string;

  @PrimaryColumn({ type: 'varchar', length: 255 })
  username: string;

  @Column({ type: 'text' })
  encryptedValues: string;

  @Column({ type: 'varchar', length: 30 })
  updatedAt: string;

  // Keyed fingerprint of the destination these values were bound to; null on rows
  // written before it existed (they adopt the current one on first use).
  @Column({ type: 'varchar', length: 80, nullable: true })
  destinationFingerprint?: string | null;
}
