import type { Request, Response } from 'express';
import { getServerDao } from '../dao/DaoFactory.js';
import {
  authorizationService,
  type CredentialWriteGrantInfo,
  type RequestPrincipal,
} from '../services/authorizationService.js';
import {
  deleteCredentialBindings,
  getCredentialBindingStatus,
  saveCredentialBinding,
} from '../services/credentialBindingService.js';
import { ActivityLoggingService } from '../services/activityLoggingService.js';
import { logger } from '../utils/logger.js';
import { notifyWorkspaceUser } from '../services/userServerStatusService.js';
import {
  CredentialBindingError,
  hasCredentialTemplate,
  validateCredentialTemplate,
} from '../utils/credentialTemplate.js';

// Principal is supplied exclusively by dashboard authentication, never the URL/body.
const principal = (req: Request) => (req as Request & { user?: RequestPrincipal }).user;
const respondError = (res: Response, error: unknown) => {
  res.status(error instanceof CredentialBindingError ? 400 : 500).json({
    success: false,
    message:
      error instanceof CredentialBindingError
        ? error.message
        : 'Unable to manage personal credentials',
  });
};

export const listMyCredentials = async (req: Request, res: Response): Promise<void> => {
  const user = principal(req);
  if (!user || user.credentialEligible === false) {
    res.status(401).json({ success: false });
    return;
  }
  // A credential-write token is for one server's binding only, never for the list.
  if (user.credentialWriteGrant) {
    res.status(403).json({ success: false });
    return;
  }
  try {
    const servers = (await getServerDao().findAll()).filter(
      (server) =>
        hasCredentialTemplate(server) && authorizationService.can('server.discover', server, user),
    );
    const data = await Promise.all(
      servers.map(async (server) => ({
        serverName: server.name,
        credentialTemplate: validateCredentialTemplate(server),
        ...(await getCredentialBindingStatus(server.name, user.username, server)),
      })),
    );
    res.json({ success: true, data });
  } catch (error) {
    respondError(res, error);
  }
};

export const updateMyCredential = async (req: Request, res: Response): Promise<void> => {
  const user = principal(req);
  if (!user || user.credentialEligible === false) {
    res.status(401).json({ success: false });
    return;
  }
  const grant = user.credentialWriteGrant;
  if (grant && grant.serverName !== req.params.name) {
    res.status(403).json({ success: false, message: 'This token cannot be used for that server' });
    return;
  }
  const startedAt = Date.now();
  const operation = req.method === 'DELETE' ? 'delete' : 'write';
  try {
    const server = await getServerDao().findById(req.params.name);
    if (!server || !authorizationService.can('server.discover', server, user)) {
      res.status(404).json({ success: false, message: 'Server not available' });
      return;
    }
    if (req.method === 'DELETE')
      await deleteCredentialBindings({ serverName: server.name, username: user.username });
    else await saveCredentialBinding(server.name, user.username, server, req.body?.values);
    await notifyWorkspaceUser(user.username);
    if (grant) await auditCredentialWrite(user, grant, operation, 'success', startedAt);
    res.json({ success: true });
  } catch (error) {
    if (grant) await auditCredentialWrite(user, grant, operation, 'error', startedAt);
    respondError(res, error);
  }
};

// Who wrote which server's credentials through which client. Identifiers only: never a slot
// value, and not the validation message, which can name a slot.
const auditCredentialWrite = async (
  user: RequestPrincipal,
  grant: CredentialWriteGrantInfo,
  operation: 'write' | 'delete',
  status: 'success' | 'error',
  startedAt: number,
): Promise<void> => {
  logger.log(
    `Credential ${operation} via credentials:write scope ${status}: user=${user.username} client=${grant.clientId} server=${grant.serverName}`,
  );
  await ActivityLoggingService.getInstance().logToolCall({
    server: grant.serverName,
    tool: `credentials.${operation}`,
    duration: Date.now() - startedAt,
    status,
    username: user.username,
    clientKind: 'oauth',
    clientId: grant.clientId,
    hasCredentialTemplate: true,
  });
};
