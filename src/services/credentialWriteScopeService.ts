import { getServerDao } from '../dao/index.js';
import { hasCredentialTemplate } from '../utils/credentialTemplate.js';
import {
  includesCredentialWriteScope,
  soleCredentialWriteServer,
  splitScopes,
} from '../utils/credentialWriteScope.js';
import type { ServerConfig } from '../types/index.js';

export type CredentialWriteEvaluation =
  | { kind: 'none' }
  | { kind: 'granted'; serverName: string; server: ServerConfig }
  | { kind: 'denied' };

/**
 * Decide whether a scope set that names `credentials:write:<server>` may be held by `clientId`.
 *
 * The scope is valid only on its own (never mixed), for a server that exists, has credential
 * slots and lists this client in `credentialWriteClients`. Used when the scope is requested,
 * when the code is exchanged, and on every request the token makes, so removing a client from
 * the list takes effect at once.
 */
export const evaluateCredentialWriteScopes = async (
  clientId: string,
  scope: string | string[] | undefined | null,
): Promise<CredentialWriteEvaluation> => {
  if (!includesCredentialWriteScope(scope)) return { kind: 'none' };

  const serverName = soleCredentialWriteServer(splitScopes(scope));
  if (!serverName) return { kind: 'denied' };

  const server = await getServerDao().findById(serverName);
  if (
    !server ||
    !hasCredentialTemplate(server) ||
    !Array.isArray(server.credentialWriteClients) ||
    !server.credentialWriteClients.includes(clientId)
  ) {
    return { kind: 'denied' };
  }
  return { kind: 'granted', serverName: server.name ?? serverName, server };
};
