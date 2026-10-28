import { IOAuthToken } from '../types/index.js';
import { BaseDao } from './base/BaseDao.js';
import { JsonFileBaseDao } from './base/JsonFileBaseDao.js';
import { mergeLastUsed, pruneUsage, recordUsage, usageKeyForToken } from './clientUsageStore.js';

/**
 * OAuth Token DAO interface with OAuth token-specific operations
 */
export interface OAuthTokenDao extends BaseDao<IOAuthToken, string> {
  /**
   * Find token by access token
   */
  findByAccessToken(accessToken: string): Promise<IOAuthToken | null>;

  /**
   * Find token by refresh token
   */
  findByRefreshToken(refreshToken: string): Promise<IOAuthToken | null>;

  /**
   * Find tokens by client ID
   */
  findByClientId(clientId: string): Promise<IOAuthToken[]>;

  /**
   * Find tokens by username
   */
  findByUsername(username: string): Promise<IOAuthToken[]>;

  /**
   * Record that the access token authenticated a request. A targeted write: it never
   * recreates a revoked token or changes any other field.
   */
  recordLastUsed(accessToken: string, at: string): Promise<void>;

  /**
   * Revoke token (delete by access token or refresh token)
   */
  revokeToken(token: string): Promise<boolean>;

  /**
   * Revoke all tokens for a user
   */
  revokeUserTokens(username: string): Promise<number>;

  /**
   * Revoke all tokens for a client
   */
  revokeClientTokens(clientId: string): Promise<number>;

  /**
   * Revoke the tokens one client holds for one user (other users' tokens for the
   * same client are left alone)
   */
  revokeUserClientTokens(username: string, clientId: string): Promise<number>;
  /** Revoke what one client holds for one user and one external resource. */
  revokeUserClientResourceTokens(
    username: string,
    clientId: string,
    resource: string,
  ): Promise<number>;

  /**
   * Clean up expired tokens
   */
  cleanupExpired(): Promise<number>;

  /**
   * Check if access token is valid (exists and not expired)
   */
  isAccessTokenValid(accessToken: string): Promise<boolean>;

  /**
   * Check if refresh token is valid (exists and not expired)
   */
  isRefreshTokenValid(refreshToken: string): Promise<boolean>;
}

/**
 * JSON file-based OAuth Token DAO implementation
 */
export class OAuthTokenDaoImpl extends JsonFileBaseDao implements OAuthTokenDao {
  protected async getAll(): Promise<IOAuthToken[]> {
    const settings = await this.loadSettings();
    // Convert stored dates back to Date objects
    return (settings.oauthTokens || []).map((token) => ({
      ...token,
      // Last use lives in the usage sidecar, not in the settings file.
      lastUsedAt: mergeLastUsed(token.lastUsedAt, usageKeyForToken(token.accessToken)),
      accessTokenExpiresAt: new Date(token.accessTokenExpiresAt),
      refreshTokenExpiresAt: token.refreshTokenExpiresAt
        ? new Date(token.refreshTokenExpiresAt)
        : undefined,
    }));
  }

  protected async saveAll(tokens: IOAuthToken[]): Promise<void> {
    const settings = await this.loadSettings();
    settings.oauthTokens = tokens.map(({ lastUsedAt: _lastUsedAt, ...token }) => token);
    await this.saveSettings(settings);
    pruneUsage('oauth:', new Set(tokens.map((token) => usageKeyForToken(token.accessToken))));
  }

  async recordLastUsed(accessToken: string, at: string): Promise<void> {
    recordUsage(usageKeyForToken(accessToken), at);
  }

  protected getEntityId(token: IOAuthToken): string {
    return token.accessToken;
  }

  protected createEntity(_data: Omit<IOAuthToken, 'accessToken'>): IOAuthToken {
    throw new Error('accessToken must be provided');
  }

  protected updateEntity(existing: IOAuthToken, updates: Partial<IOAuthToken>): IOAuthToken {
    return {
      ...existing,
      ...updates,
      accessToken: existing.accessToken, // accessToken should not be updated
    };
  }

  async findAll(): Promise<IOAuthToken[]> {
    return this.getAll();
  }

  async findById(accessToken: string): Promise<IOAuthToken | null> {
    return this.findByAccessToken(accessToken);
  }

  async findByAccessToken(accessToken: string): Promise<IOAuthToken | null> {
    const tokens = await this.getAll();
    return tokens.find((token) => token.accessToken === accessToken) || null;
  }

  async findByRefreshToken(refreshToken: string): Promise<IOAuthToken | null> {
    const tokens = await this.getAll();
    return tokens.find((token) => token.refreshToken === refreshToken) || null;
  }

  async findByClientId(clientId: string): Promise<IOAuthToken[]> {
    const tokens = await this.getAll();
    return tokens.filter((token) => token.clientId === clientId);
  }

  async findByUsername(username: string): Promise<IOAuthToken[]> {
    const tokens = await this.getAll();
    return tokens.filter((token) => token.username === username);
  }

  async create(data: IOAuthToken): Promise<IOAuthToken> {
    const tokens = await this.getAll();

    // Remove any existing tokens with the same access token or refresh token
    const filteredTokens = tokens.filter(
      (t) => t.accessToken !== data.accessToken && t.refreshToken !== data.refreshToken,
    );

    const newToken: IOAuthToken = {
      ...data,
    };
    // A rotated token inherits the grant's last use; it goes to the sidecar like any other.
    if (data.lastUsedAt) recordUsage(usageKeyForToken(data.accessToken), data.lastUsedAt);

    filteredTokens.push(newToken);
    await this.saveAll(filteredTokens);

    return newToken;
  }

  async update(accessToken: string, updates: Partial<IOAuthToken>): Promise<IOAuthToken | null> {
    const tokens = await this.getAll();
    const index = tokens.findIndex((token) => token.accessToken === accessToken);

    if (index === -1) {
      return null;
    }

    // Don't allow accessToken changes
    const { accessToken: _, lastUsedAt, ...allowedUpdates } = updates;
    if (lastUsedAt) recordUsage(usageKeyForToken(accessToken), lastUsedAt);
    const updatedToken = this.updateEntity(tokens[index], allowedUpdates);
    tokens[index] = updatedToken;

    await this.saveAll(tokens);
    return updatedToken;
  }

  async delete(accessToken: string): Promise<boolean> {
    const tokens = await this.getAll();
    const index = tokens.findIndex((token) => token.accessToken === accessToken);
    if (index === -1) {
      return false;
    }

    tokens.splice(index, 1);
    await this.saveAll(tokens);
    return true;
  }

  async exists(accessToken: string): Promise<boolean> {
    const token = await this.findByAccessToken(accessToken);
    return token !== null;
  }

  async count(): Promise<number> {
    const tokens = await this.getAll();
    return tokens.length;
  }

  async revokeToken(token: string): Promise<boolean> {
    const tokens = await this.getAll();
    const tokenData = tokens.find((t) => t.accessToken === token || t.refreshToken === token);

    if (!tokenData) {
      return false;
    }

    const filteredTokens = tokens.filter(
      (t) => t.accessToken !== tokenData.accessToken && t.refreshToken !== tokenData.refreshToken,
    );

    await this.saveAll(filteredTokens);
    return true;
  }

  async revokeUserTokens(username: string): Promise<number> {
    const tokens = await this.getAll();
    const userTokens = tokens.filter((token) => token.username === username);
    const remainingTokens = tokens.filter((token) => token.username !== username);

    await this.saveAll(remainingTokens);
    return userTokens.length;
  }

  async revokeClientTokens(clientId: string): Promise<number> {
    const tokens = await this.getAll();
    const clientTokens = tokens.filter((token) => token.clientId === clientId);
    const remainingTokens = tokens.filter((token) => token.clientId !== clientId);

    await this.saveAll(remainingTokens);
    return clientTokens.length;
  }

  async revokeUserClientTokens(username: string, clientId: string): Promise<number> {
    const tokens = await this.getAll();
    const remaining = tokens.filter(
      (token) => !(token.username === username && token.clientId === clientId),
    );
    const removed = tokens.length - remaining.length;
    if (removed > 0) await this.saveAll(remaining);
    return removed;
  }

  async revokeUserClientResourceTokens(
    username: string,
    clientId: string,
    resource: string,
  ): Promise<number> {
    const tokens = await this.getAll();
    const remaining = tokens.filter(
      (token) =>
        !(
          token.username === username &&
          token.clientId === clientId &&
          token.resource === resource
        ),
    );
    const removed = tokens.length - remaining.length;
    if (removed > 0) await this.saveAll(remaining);
    return removed;
  }

  async cleanupExpired(): Promise<number> {
    const tokens = await this.getAll();
    const now = new Date();

    const validTokens = tokens.filter((token) => {
      // Keep if access token is still valid
      if (token.accessTokenExpiresAt > now) {
        return true;
      }
      // Or if refresh token exists and is still valid
      if (token.refreshToken && token.refreshTokenExpiresAt && token.refreshTokenExpiresAt > now) {
        return true;
      }
      return false;
    });

    const expiredCount = tokens.length - validTokens.length;
    if (expiredCount > 0) {
      await this.saveAll(validTokens);
    }

    return expiredCount;
  }

  async isAccessTokenValid(accessToken: string): Promise<boolean> {
    const token = await this.findByAccessToken(accessToken);
    if (!token) {
      return false;
    }
    return token.accessTokenExpiresAt > new Date();
  }

  async isRefreshTokenValid(refreshToken: string): Promise<boolean> {
    const token = await this.findByRefreshToken(refreshToken);
    if (!token) {
      return false;
    }
    if (!token.refreshTokenExpiresAt) {
      return true; // No expiration means always valid
    }
    return token.refreshTokenExpiresAt > new Date();
  }
}
