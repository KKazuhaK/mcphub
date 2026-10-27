import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A signing key for the JWT access tokens MCPHub issues for external resources (ADR 0014).
 * `publicJwk` is published at /.well-known/jwks.json; `privateKey` is sealed with the credential
 * encryption key when one is available and never leaves this table.
 */
@Entity({ name: 'oauth_signing_keys' })
export class OAuthSigningKey {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  kid: string;

  @Column({ name: 'public_jwk', type: 'simple-json' })
  publicJwk: Record<string, unknown>;

  @Column({ name: 'private_key', type: 'text' })
  privateKey: string;

  @Column({ name: 'created_at', type: 'varchar', length: 30 })
  createdAt: string;

  @Column({ name: 'activate_at', type: 'varchar', length: 30, nullable: true })
  activateAt?: string | null;

  @Column({ name: 'retired_at', type: 'varchar', length: 30, nullable: true })
  retiredAt?: string | null;
}

export default OAuthSigningKey;
