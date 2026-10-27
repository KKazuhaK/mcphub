import type { Request, Response } from 'express';
import config, { getNameSeparator } from '../config/index.js';
import { getGroupDao, getServerDao } from '../dao/DaoFactory.js';
import type { RequestPrincipal } from '../services/authorizationService.js';
import { getCredentialBindingStatus } from '../services/credentialBindingService.js';
import { getDataService } from '../services/services.js';
import {
  getSelectedServerNames,
  isWorkspaceEnabled,
  setServerSelected,
} from '../services/userServerSelectionService.js';
import type { IUser, ServerConfig } from '../types/index.js';
import { hasCredentialTemplate, hasPersonalAuthentication } from '../utils/credentialTemplate.js';
import { getPublicInstallBaseUrl } from '../utils/protectedResource.js';
import { getCachedSystemConfig } from '../utils/systemConfigCache.js';

type ServerRecord = ServerConfig & { name: string };

// The user is supplied exclusively by dashboard authentication, never the URL/body.
const principal = (req: Request) => (req as Request & { user?: RequestPrincipal }).user;

// Returns the caller when workspace selection is available; otherwise responds and returns null.
const requireWorkspaceUser = (req: Request, res: Response): RequestPrincipal | null => {
  if (!isWorkspaceEnabled()) {
    res.status(404).json({ success: false, message: 'Not found' });
    return null;
  }
  const user = principal(req);
  if (!user?.username) {
    res.status(401).json({ success: false, message: 'Authentication required' });
    return null;
  }
  return user;
};

// Same visibility rule as the dashboard server list.
const filterVisible = <T>(servers: T[], user: RequestPrincipal): T[] =>
  getDataService().filterData(servers, user as unknown as IUser);

const listVisibleServers = async (user: RequestPrincipal): Promise<ServerRecord[]> =>
  filterVisible(await getServerDao().findAll(), user) as ServerRecord[];

// The runtime services pull in the whole upstream client stack, so they load on first use.
const countEnabledTools = async (server: ServerRecord): Promise<number> => {
  const { getServerByName } = await import('../services/mcpService.js');
  const prefix = `${server.name}${getNameSeparator()}`;
  return (getServerByName(server.name)?.tools ?? []).filter((tool) => {
    const bare = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
    return (server.tools?.[tool.name] ?? server.tools?.[bare])?.enabled !== false;
  }).length;
};

// True when nothing personal is missing: either the server needs no personal
// credential, or the user has supplied it.
const isPersonalCredentialConfigured = async (
  user: RequestPrincipal,
  server: ServerRecord,
): Promise<boolean> => {
  if (!hasPersonalAuthentication(server)) return true;
  if (user.credentialEligible === false) return false;
  try {
    if (hasCredentialTemplate(server)) {
      return (await getCredentialBindingStatus(server.name, user.username, server)).configured;
    }
    const { hasPersonalOAuth, PersonalOAuthContext } = await import(
      '../services/personalOAuthService.js'
    );
    if (hasPersonalOAuth(server)) {
      const personal = await PersonalOAuthContext.load(server.name, user.username, server);
      return Boolean(personal.config.oauth.accessToken);
    }
  } catch {
    return false;
  }
  return true;
};

export const listWorkspaceServers = async (req: Request, res: Response): Promise<void> => {
  const user = requireWorkspaceUser(req, res);
  if (!user) return;
  try {
    const selected = await getSelectedServerNames(user.username);
    const data = await Promise.all(
      (await listVisibleServers(user)).map(async (server) => ({
        name: server.name,
        description: server.description,
        selected: selected.has(server.name),
        enabled: server.enabled !== false,
        toolCount: await countEnabledTools(server),
        requiresPersonalCredential: hasPersonalAuthentication(server),
        credentialConfigured: await isPersonalCredentialConfigured(user, server),
      })),
    );
    res.json({ success: true, data });
  } catch {
    res.status(500).json({ success: false, message: 'Unable to list workspace servers' });
  }
};

export const updateWorkspaceSelection = async (req: Request, res: Response): Promise<void> => {
  const user = requireWorkspaceUser(req, res);
  if (!user) return;
  const selected = req.body?.selected;
  if (typeof selected !== 'boolean') {
    res.status(400).json({ success: false, message: 'selected must be a boolean' });
    return;
  }
  try {
    const server = await getServerDao().findById(req.params.name);
    if (!server || !filterVisible([server], user).length) {
      res.status(404).json({ success: false, message: 'Server not found' });
      return;
    }
    await setServerSelected(user.username, server.name, selected);
    const { notifyUserListsChanged } = await import('../services/mcpService.js');
    notifyUserListsChanged(user.username);
    res.json({ success: true, data: { name: server.name, selected } });
  } catch {
    res.status(500).json({ success: false, message: 'Unable to update server selection' });
  }
};

export const getWorkspaceEndpoints = async (req: Request, res: Response): Promise<void> => {
  const user = requireWorkspaceUser(req, res);
  if (!user) return;
  try {
    const systemConfig = getCachedSystemConfig();
    const publicBase = new URL(getPublicInstallBaseUrl(req, systemConfig)!);
    // A configured public URL already carries any deployment prefix.
    const configured =
      systemConfig?.install?.baseUrl?.trim() || process.env.INSTALL_BASE_URL?.trim();
    const prefix = (configured ? publicBase.pathname : config.basePath || '').replace(/\/+$/, '');
    const aggregate = `${publicBase.origin}${prefix}/${encodeURIComponent(user.username)}/mcp`;

    const selected = await getSelectedServerNames(user.username);
    const groupDao = getGroupDao();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // A route segment naming both a group and a server resolves to the group, which is
    // exempt from selection, so such a server has no per-server endpoint of its own.
    const isGroupRoute = async (name: string) =>
      Boolean(
        (await groupDao.findByName(name)) || (uuid.test(name) && (await groupDao.findById(name))),
      );
    const servers = await Promise.all(
      (await listVisibleServers(user))
        .filter((server) => server.enabled !== false && selected.has(server.name))
        .map(async (server) =>
          (await isGroupRoute(server.name))
            ? { name: server.name, url: null, conflict: 'group-name' as const }
            : { name: server.name, url: `${aggregate}/${encodeURIComponent(server.name)}` },
        ),
    );
    res.json({ success: true, data: { aggregate, servers } });
  } catch {
    res.status(500).json({ success: false, message: 'Unable to build workspace endpoints' });
  }
};
