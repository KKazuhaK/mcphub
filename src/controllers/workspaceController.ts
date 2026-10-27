import type { Request, Response } from 'express';
import config, { getNameSeparator } from '../config/index.js';
import { getGroupDao, getServerDao } from '../dao/DaoFactory.js';
import type { RequestPrincipal } from '../services/authorizationService.js';
import { getDataService } from '../services/services.js';
import {
  listConnectedClients,
  revokeAllConnectedClients,
  revokeConnectedClient,
  type ConnectedClientKind,
} from '../services/connectedClientService.js';
import {
  getUserSelectionScope,
  isWorkspaceEnabled,
  resolveRiskCeiling,
  setServerRiskCeiling,
  setServerSelected,
} from '../services/userServerSelectionService.js';
import {
  countUserServerStatuses,
  getPersonalAuthState,
  getUserServerStatus,
  resolveEndpointState,
  type PersonalAuthState,
} from '../services/userServerStatusService.js';
import type { IUser, ServerConfig, ToolRiskLevel, UserServerStatus } from '../types/index.js';
import {
  TOOL_RISK_LEVELS,
  getEffectiveToolRisk,
  getDefaultUserRisk,
  getMaxToolRisk,
  isToolRiskLevel,
  minRisk,
  riskRank,
} from '../utils/toolRisk.js';
import { hasPersonalAuthentication } from '../utils/credentialTemplate.js';
import { areAnnotationsTrusted, primeAnnotationTrust } from '../services/annotationTrustService.js';
import { getPublicInstallBaseUrl } from '../utils/protectedResource.js';
import {
  DEFAULT_HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGE_SIZE,
  decodeCursor,
  isActivityHistoryAvailable,
  listUserActivity,
  type ActivityHistoryFilters,
} from '../services/workspaceActivityService.js';
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

// The highest level the administrator lets this user use on a server. Administrators are not
// capped.
const adminCapFor = (server: ServerRecord, user: RequestPrincipal): ToolRiskLevel =>
  user.isAdmin === true ? 'external' : getMaxToolRisk(server);

type ToolSummary = {
  // Enabled tools within the user's ceiling: what their endpoint exposes. Null when the
  // tools are not known (see below).
  toolCount: number | null;
  // Enabled tools within the administrator's cap, by level. Null when not known.
  riskCounts: Record<ToolRiskLevel, number> | null;
};

// The runtime services pull in the whole upstream client stack, so they load on first use.
const summarizeTools = async (
  server: ServerRecord,
  user: RequestPrincipal,
  ceiling: ToolRiskLevel,
): Promise<ToolSummary> => {
  const { getServerByName } = await import('../services/mcpService.js');
  const prefix = `${server.name}${getNameSeparator()}`;
  const live = getServerByName(server.name)?.tools ?? [];
  // A server needing personal credentials has no shared tool list: what the user would get
  // is unknown until they connect, which is not the same as having no tools.
  if (live.length === 0 && hasPersonalAuthentication(server)) {
    return { toolCount: null, riskCounts: null };
  }
  const trusted = areAnnotationsTrusted(server.owner);
  const runtimeNames = live.map((tool) => tool.name);
  const allowed = minRisk(ceiling, adminCapFor(server, user));
  const summary = {
    toolCount: 0,
    riskCounts: { read: 0, write: 0, external: 0 } as Record<ToolRiskLevel, number>,
  };
  for (const tool of live) {
    const bare = tool.name.startsWith(prefix) ? tool.name.slice(prefix.length) : tool.name;
    if ((server.tools?.[tool.name] ?? server.tools?.[bare])?.enabled === false) continue;
    const level = getEffectiveToolRisk(server.name, tool, server, runtimeNames, trusted);
    if (riskRank(level) > riskRank(adminCapFor(server, user))) continue;
    summary.riskCounts[level]++;
    if (riskRank(level) <= riskRank(allowed)) summary.toolCount++;
  }
  return summary;
};

const loadServerInfo = async (name: string) => {
  const { getServerByName } = await import('../services/mcpService.js');
  return getServerByName(name);
};

type WorkspaceServerView = {
  server: ServerRecord;
  selected: boolean;
  riskCeiling: ToolRiskLevel;
  // True until the user chooses a level, so the server's default applies.
  riskCeilingIsDefault: boolean;
  personalAuth: PersonalAuthState;
  status: UserServerStatus;
};

// One entry per server the user can see, with the state they would meet calling it.
const buildServerViews = async (
  req: Request,
  user: RequestPrincipal,
): Promise<WorkspaceServerView[]> => {
  await primeAnnotationTrust();
  const { names: selected, ceilings } = await getUserSelectionScope(user.username);
  const language = (req as Request & { language?: string }).language;
  return Promise.all(
    (await listVisibleServers(user)).map(async (server) => {
      const personalAuth = await getPersonalAuthState(user, server.name, server);
      const status = await getUserServerStatus({
        user,
        subject: {
          name: server.name,
          config: server,
          enabled: server.enabled !== false,
          info: await loadServerInfo(server.name),
        },
        selected: selected.has(server.name),
        personalAuth,
        language,
      });
      return {
        server,
        selected: selected.has(server.name),
        // The user's choice, else the server's default; never above what the cap allows.
        riskCeiling: minRisk(
          resolveRiskCeiling(ceilings, server.name, getDefaultUserRisk(server)),
          adminCapFor(server, user),
        ),
        riskCeilingIsDefault: !ceilings.has(server.name),
        personalAuth,
        status,
      };
    }),
  );
};

export const listWorkspaceServers = async (req: Request, res: Response): Promise<void> => {
  const user = requireWorkspaceUser(req, res);
  if (!user) return;
  try {
    const data = await Promise.all(
      (await buildServerViews(req, user)).map(
        async ({ server, selected, riskCeiling, riskCeilingIsDefault, personalAuth, status }) => {
          const tools = await summarizeTools(server, user, riskCeiling);
          return {
            name: server.name,
            description: server.description,
            selected,
            enabled: server.enabled !== false,
            toolCount: tools.toolCount,
            riskCeiling,
            riskCeilingIsDefault,
            annotationsTrusted: areAnnotationsTrusted(server.owner),
            riskCounts: tools.riskCounts,
            maxAllowedRisk: adminCapFor(server, user),
            requiresPersonalCredential: hasPersonalAuthentication(server),
            credentialConfigured: personalAuth === 'not_required' || personalAuth === 'configured',
            status,
          };
        },
      ),
    );
    res.json({ success: true, data });
  } catch {
    res.status(500).json({ success: false, message: 'Unable to list workspace servers' });
  }
};

export const getWorkspaceSummary = async (req: Request, res: Response): Promise<void> => {
  const user = requireWorkspaceUser(req, res);
  if (!user) return;
  try {
    const codes = (await buildServerViews(req, user)).map((view) => view.status.code);
    res.json({
      success: true,
      data: { endpointState: resolveEndpointState(codes), counts: countUserServerStatuses(codes) },
    });
  } catch {
    res.status(500).json({ success: false, message: 'Unable to summarize the workspace' });
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

// Changes how far the caller lets tools of one server reach. Does not touch their selection.
export const updateWorkspaceRisk = async (req: Request, res: Response): Promise<void> => {
  const user = requireWorkspaceUser(req, res);
  if (!user) return;
  const riskCeiling = req.body?.riskCeiling;
  if (!isToolRiskLevel(riskCeiling)) {
    res.status(400).json({
      success: false,
      message: `riskCeiling must be one of ${TOOL_RISK_LEVELS.join(', ')}`,
    });
    return;
  }
  try {
    const server = await getServerDao().findById(req.params.name);
    if (!server || !filterVisible([server], user).length) {
      res.status(404).json({ success: false, message: 'Server not found' });
      return;
    }
    const maxAllowedRisk = adminCapFor(server as ServerRecord, user);
    if (riskRank(riskCeiling) > riskRank(maxAllowedRisk)) {
      res.status(400).json({ success: false, message: 'This level is not allowed on this server' });
      return;
    }
    await setServerRiskCeiling(user.username, server.name, riskCeiling);
    const { notifyUserListsChanged } = await import('../services/mcpService.js');
    notifyUserListsChanged(user.username);
    res.json({ success: true, data: { name: server.name, riskCeiling } });
  } catch {
    res.status(500).json({ success: false, message: 'Unable to update the tool risk level' });
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

    const { names: selected } = await getUserSelectionScope(user.username);
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

// Every credential that can act as the caller on MCP routes. Secrets are never returned.
export const listWorkspaceClients = async (req: Request, res: Response): Promise<void> => {
  const user = requireWorkspaceUser(req, res);
  if (!user) return;
  try {
    res.json({
      success: true,
      data: await listConnectedClients(user.username, getCachedSystemConfig()),
    });
  } catch {
    res.status(500).json({ success: false, message: 'Unable to list connected clients' });
  }
};

// Revokes one of the caller's own clients. An id that belongs to someone else and one that
// does not exist answer identically.
export const revokeWorkspaceClient = async (req: Request, res: Response): Promise<void> => {
  const user = requireWorkspaceUser(req, res);
  if (!user) return;
  const { kind, id } = req.params;
  try {
    const revoked =
      (kind === 'oauth' || kind === 'key') &&
      (await revokeConnectedClient(user.username, kind as ConnectedClientKind, id));
    if (!revoked) {
      res.status(404).json({ success: false, message: 'Client not found' });
      return;
    }
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: 'Unable to revoke the client' });
  }
};

export const revokeAllWorkspaceClients = async (req: Request, res: Response): Promise<void> => {
  const user = requireWorkspaceUser(req, res);
  if (!user) return;
  try {
    await revokeAllConnectedClients(user.username);
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: 'Unable to revoke clients' });
  }
};

const queryText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, 255) : undefined;

const queryDate = (value: unknown): Date | null | undefined => {
  const text = queryText(value);
  if (text === undefined) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
};

// The caller's own call history: which client called which tool of which service, when, and how
// it ended. The user comes from the session only. Tool input and output are never returned,
// and neither is the recorded error text: a failure is reported as a short category.
export const listWorkspaceActivity = async (req: Request, res: Response): Promise<void> => {
  const user = requireWorkspaceUser(req, res);
  if (!user) return;
  // History is only stored in database mode; the page explains that instead of failing.
  if (!isActivityHistoryAvailable()) {
    res.json({ success: true, data: { available: false } });
    return;
  }

  const bad = (message: string) => res.status(400).json({ success: false, message });
  const filters: ActivityHistoryFilters = {
    server: queryText(req.query.server),
    clientId: queryText(req.query.clientId),
  };

  const status = queryText(req.query.status);
  if (status !== undefined) {
    if (status !== 'success' && status !== 'error' && status !== 'blocked') {
      bad('status must be success, error or blocked');
      return;
    }
    filters.status = status;
  }
  const clientKind = queryText(req.query.clientKind);
  if (clientKind !== undefined) {
    if (clientKind !== 'oauth' && clientKind !== 'key') {
      bad('clientKind must be oauth or key');
      return;
    }
    filters.clientKind = clientKind;
  }
  const since = queryDate(req.query.since);
  const until = queryDate(req.query.until);
  if (since === null || until === null) {
    bad('since and until must be dates');
    return;
  }
  filters.since = since;
  filters.until = until;

  let limit = DEFAULT_HISTORY_PAGE_SIZE;
  if (req.query.limit !== undefined) {
    limit = Number(queryText(req.query.limit));
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE_SIZE) {
      bad(`limit must be an integer from 1 to ${MAX_HISTORY_PAGE_SIZE}`);
      return;
    }
  }
  const cursorText = queryText(req.query.cursor);
  const cursor = cursorText === undefined ? undefined : decodeCursor(cursorText);
  if (cursor === null) {
    bad('cursor is not valid');
    return;
  }

  try {
    const page = await listUserActivity(user.username, {
      filters,
      limit,
      cursor,
      systemConfig: getCachedSystemConfig(),
    });
    res.json({ success: true, data: { available: true, ...page } });
  } catch {
    res.status(500).json({ success: false, message: 'Unable to load activity' });
  }
};
