import type {
  WorkspaceActivityClient,
  WorkspaceActivityItem,
  WorkspaceActivityStatus,
  WorkspaceServer,
  WorkspaceStatusCode,
  WorkspaceSummary,
} from '../types';
import {
  buildClientSnippetBlocks,
  type ClientSnippetBlock,
  type ClientSnippetId,
} from './mcpClientSnippets';

/** More tools than this starts to crowd a model's context. */
export const TOOL_COUNT_WARN = 40;
/** Beyond this, suggest smart routing or per-service endpoints. */
export const TOOL_COUNT_STRONG = 80;

export type ToolCountLevel = 'ok' | 'warn' | 'strong';

export const toolCountLevel = (total: number): ToolCountLevel =>
  total > TOOL_COUNT_STRONG ? 'strong' : total > TOOL_COUNT_WARN ? 'warn' : 'ok';

/** Tools a client would see on the personal endpoint: selected services that are available. */
export const countExposedTools = (servers: readonly WorkspaceServer[]): number =>
  servers
    .filter((server) => server.selected && server.status.code === 'available')
    .reduce((sum, server) => sum + (server.toolCount || 0), 0);

export type SummaryBannerKind = 'normal' | 'partial' | 'none_selected' | 'none_usable';

export interface SummaryBanner {
  kind: SummaryBannerKind;
  selected: number;
  attention: number;
}

/** Selected services that are not usable right now. */
export const countNeedingAttention = (counts: WorkspaceSummary['counts']): number =>
  (Object.keys(counts) as WorkspaceStatusCode[])
    .filter((code) => code !== 'available' && code !== 'not_selected')
    .reduce((sum, code) => sum + (counts[code] || 0), 0);

export const resolveSummaryBanner = (summary: WorkspaceSummary): SummaryBanner => {
  const attention = countNeedingAttention(summary.counts);
  const selected = (summary.counts.available || 0) + attention;
  if (summary.endpointState === 'normal') return { kind: 'normal', selected, attention };
  if (summary.endpointState === 'partial') return { kind: 'partial', selected, attention };
  return { kind: selected === 0 ? 'none_selected' : 'none_usable', selected, attention };
};

export type ServiceAction =
  | { kind: 'none' }
  | { kind: 'select' }
  | { kind: 'credentials'; server: string }
  | { kind: 'oauth'; server: string }
  | { kind: 'contact_admin' }
  | { kind: 'retry_later'; until?: string };

/**
 * Maps a server's status action to what the UI offers. `connect` goes to the Credentials page
 * (deep link) for servers with credential slots, and starts the personal OAuth flow otherwise.
 * A disconnected personal OAuth (`revoked`) always reconnects through OAuth.
 * `credentialServers` is null when the list of servers with slots could not be loaded; the
 * Credentials page is the safer destination then.
 */
export const resolveServiceAction = (
  server: Pick<WorkspaceServer, 'name' | 'status'>,
  credentialServers: ReadonlySet<string> | null,
): ServiceAction => {
  switch (server.status.action) {
    case 'select':
      return { kind: 'select' };
    case 'connect': {
      const hasSlots = credentialServers ? credentialServers.has(server.name) : true;
      return hasSlots && server.status.code !== 'revoked'
        ? { kind: 'credentials', server: server.name }
        : { kind: 'oauth', server: server.name };
    }
    case 'contact_admin':
      return { kind: 'contact_admin' };
    case 'retry_later':
      return { kind: 'retry_later', until: server.status.until };
    default:
      return { kind: 'none' };
  }
};

export const credentialsPath = (server: string): string =>
  `/credentials?server=${encodeURIComponent(server)}`;

export const applySelection = (
  servers: readonly WorkspaceServer[],
  name: string,
  selected: boolean,
): WorkspaceServer[] =>
  servers.map((server) => (server.name === name ? { ...server, selected } : server));

export interface ToggleDeps {
  save: (name: string, selected: boolean) => Promise<void>;
  update: (updater: (servers: WorkspaceServer[]) => WorkspaceServer[]) => void;
}

/**
 * Flips the selection in the UI first, then saves it; reverts only that row if saving fails.
 * Resolves true when the change was saved.
 */
export const toggleServerSelection = async (
  name: string,
  selected: boolean,
  deps: ToggleDeps,
): Promise<boolean> => {
  deps.update((servers) => applySelection(servers, name, selected));
  try {
    await deps.save(name, selected);
    return true;
  } catch {
    deps.update((servers) => applySelection(servers, name, !selected));
    return false;
  }
};

/** Smart-routing variant of the personal endpoint. */
export const buildSmartEndpoint = (aggregate: string, smartPath = '$smart'): string =>
  `${aggregate.replace(/\/+$/, '')}/${smartPath}`;

export const WORKSPACE_SNIPPET_CLIENTS: readonly ClientSnippetId[] = [
  'generic-mcp-servers',
  'claude-code',
  'cursor',
];

/** URL-only snippets; authentication happens through OAuth the first time a client connects. */
export const buildWorkspaceSnippets = (
  id: ClientSnippetId,
  url: string,
  name = 'mcphub',
): ClientSnippetBlock[] => buildClientSnippetBlocks(id, { name, url, type: 'streamable-http' });

export type StatusTone = 'ok' | 'warn' | 'err' | 'muted';

export const statusTone = (code: WorkspaceStatusCode): StatusTone => {
  switch (code) {
    case 'available':
      return 'ok';
    case 'maintenance':
    case 'needs_auth':
    case 'revoked':
      return 'warn';
    case 'credential_invalid':
    case 'error':
      return 'err';
    default:
      return 'muted';
  }
};

/**
 * Runs async loads so that only the newest one applies its result. `invalidate` drops every
 * load still in flight, e.g. before an optimistic change that a stale response would undo.
 */
export const createLatestOnly = () => {
  let latest = 0;
  return {
    async run<T>(load: () => Promise<T>, apply: (value: T) => void): Promise<boolean> {
      const id = ++latest;
      let value: T;
      try {
        value = await load();
      } catch (error) {
        // A superseded run is no longer wanted, so its failure is not surfaced either.
        if (id !== latest) return false;
        throw error;
      }
      if (id !== latest) return false;
      apply(value);
      return true;
    },
    invalidate(): void {
      latest++;
    },
  };
};

/** A focus refresh would overwrite optimistic rows while a selection save is in flight. */
export const shouldRefreshOnFocus = (pendingSaves: number): boolean => pendingSaves === 0;

export const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

export type OAuthLaunch =
  | { kind: 'none' }
  | { kind: 'invalid' }
  // The placeholder popup was blocked: show the link so the user can open it themselves.
  | { kind: 'link'; url: string }
  | { kind: 'navigate'; url: string };

export const resolveOAuthLaunch = (url: string | undefined, popupOpened: boolean): OAuthLaunch => {
  if (!url) return { kind: 'none' };
  if (!isHttpUrl(url)) return { kind: 'invalid' };
  return popupOpened ? { kind: 'navigate', url } : { kind: 'link', url };
};

/** Workspace endpoints answer 404 once an administrator turns the mode off. */
export const isWorkspaceDisabledMessage = (message: string | undefined): boolean =>
  /^(not found|http 404)/i.test((message ?? '').trim());

export class WorkspaceApiError extends Error {
  constructor(
    message: string,
    readonly disabled: boolean,
  ) {
    super(message);
    this.name = 'WorkspaceApiError';
  }
}

/** The backend message carries the maintenance end as an ISO instant; show it localized. */
export const localizeStatusMessage = (
  status: { message: string; until?: string },
  format: (iso: string) => string,
): string =>
  status.until ? status.message.split(status.until).join(format(status.until)) : status.message;

/**
 * What a finished read of the settings means for Workspace Mode. A failed read keeps the last
 * known value (off when there is none); a 401 means the session ended rather than a failure.
 */
export const resolveWorkspaceSetting = (
  response:
    | {
        success?: boolean;
        status?: number;
        data?: { systemConfig?: { workspace?: { enabled?: boolean } } };
      }
    | undefined,
  lastKnown?: boolean,
): { enabled: boolean; failed: boolean; signedOut: boolean } => {
  if (response?.success) {
    return {
      enabled: response.data?.systemConfig?.workspace?.enabled === true,
      failed: false,
      signedOut: false,
    };
  }
  const signedOut = response?.status === 401;
  return { enabled: lastKnown ?? false, failed: !signedOut, signedOut };
};

/** Keeps authorization links only for servers that still need the user to connect. */
export const pruneAuthLinks = (
  links: Record<string, string>,
  servers: readonly WorkspaceServer[],
): Record<string, string> => {
  const needing = new Set(
    servers.filter((server) => server.status.action === 'connect').map((server) => server.name),
  );
  const kept = Object.entries(links).filter(([name]) => needing.has(name));
  return kept.length === Object.keys(links).length ? links : Object.fromEntries(kept);
};

export const ACTIVITY_PAGE_SIZE = 25;

export interface ActivityFilters {
  server?: string;
  status?: WorkspaceActivityStatus;
  /** `<kind>:<id>`, as produced by `activityClientValue`. */
  client?: string;
}

export const activityClientValue = (client: Pick<WorkspaceActivityClient, 'kind' | 'id'>): string =>
  `${client.kind}:${client.id}`;

/** Query string for the activity endpoint; empty filters are left out. */
export const buildActivityQuery = (
  filters: ActivityFilters,
  cursor?: string | null,
  limit: number = ACTIVITY_PAGE_SIZE,
): string => {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.server) params.set('server', filters.server);
  if (filters.status) params.set('status', filters.status);
  if (filters.client) {
    const split = filters.client.indexOf(':');
    if (split > 0) {
      params.set('clientKind', filters.client.slice(0, split));
      params.set('clientId', filters.client.slice(split + 1));
    }
  }
  if (cursor) params.set('cursor', cursor);
  return `?${params.toString()}`;
};

/** Adds a later page after the rows already shown, skipping any row that is already there. */
export const appendActivityItems = (
  current: readonly WorkspaceActivityItem[],
  next: readonly WorkspaceActivityItem[],
): WorkspaceActivityItem[] => {
  const seen = new Set(current.map((item) => item.id));
  return [...current, ...next.filter((item) => !seen.has(item.id))];
};

/** Translation key for the reason column, or null when the call needs none. */
export const activityReasonKey = (
  item: Pick<WorkspaceActivityItem, 'status' | 'reason'>,
): string | null => {
  if (!item.reason || item.status === 'success') return null;
  return item.status === 'blocked'
    ? `workspacePage.status.${item.reason}`
    : `workspacePage.activity.reason.${item.reason}`;
};

/** Filter choices: what the user can see now plus anything the loaded history mentions. */
export const mergeActivityOptions = (
  known: readonly string[],
  items: readonly WorkspaceActivityItem[],
  selected?: string,
): string[] =>
  [
    ...new Set([...known, ...items.map((item) => item.server), ...(selected ? [selected] : [])]),
  ].sort((a, b) => a.localeCompare(b));

export interface ActivityClientOption {
  value: string;
  name: string | null;
}

export const mergeActivityClientOptions = (
  known: ReadonlyArray<{ kind: 'oauth' | 'key'; id: string; name: string }>,
  items: readonly WorkspaceActivityItem[],
  selected?: string,
): ActivityClientOption[] => {
  const options = new Map<string, ActivityClientOption>();
  for (const client of known) {
    options.set(activityClientValue(client), {
      value: activityClientValue(client),
      name: client.name,
    });
  }
  for (const item of items) {
    if (!item.client) continue;
    const value = activityClientValue(item.client);
    if (!options.has(value) || (!options.get(value)!.name && item.client.name)) {
      options.set(value, { value, name: item.client.name });
    }
  }
  if (selected && !options.has(selected)) options.set(selected, { value: selected, name: null });
  return [...options.values()];
};
