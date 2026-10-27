import type {
  ServerConfig,
  ServerInfo,
  UserServerStatus,
  ServerMaintenance,
  UserServerStatusAction,
  UserServerStatusCode,
  WorkspaceEndpointState,
} from '../types/index.js';
import {
  CredentialBindingConflictError,
  CredentialBindingError,
  MissingCredentialError,
  hasCredentialTemplate,
  hasPersonalAuthentication,
} from '../utils/credentialTemplate.js';
import { getT } from '../utils/i18n.js';
import { logger } from '../utils/logger.js';
import { getActiveMaintenance, isPausedForUser } from '../utils/serverMaintenance.js';
import { getCredentialBindingStatus } from './credentialBindingService.js';
import { RequestContextService } from './requestContextService.js';
import {
  clearUserServerFailure,
  getUserServerFailure,
  noteAuthRejection,
  recordUserServerFailure,
  type UserServerFailureKind,
} from './userServerFailureStore.js';
import { isWorkspaceEnabled } from './userServerSelectionService.js';

// Every state a user can see for a server, in the order they are reported.
export const USER_SERVER_STATUS_CODES: readonly UserServerStatusCode[] = [
  'not_selected',
  'paused',
  'maintenance',
  'needs_auth',
  'revoked',
  'credential_invalid',
  'error',
  'available',
];

export const USER_SERVER_STATUS_ACTIONS: Record<UserServerStatusCode, UserServerStatusAction> = {
  available: null,
  not_selected: 'select',
  paused: 'contact_admin',
  maintenance: 'retry_later',
  needs_auth: 'connect',
  revoked: 'connect',
  credential_invalid: 'connect',
  error: 'retry_later',
};

// How the requesting user stands with a server that needs a personal credential.
export type PersonalAuthState =
  | 'not_required'
  | 'configured'
  | 'missing'
  | 'revoked'
  // The user cannot hold personal credentials (e.g. a system key).
  | 'ineligible';

export interface UserServerStateInputs {
  selected: boolean;
  // The global `enabled` flag.
  enabled: boolean;
  // An administrator paused this server for this user only (`pausedUsers`).
  pausedForUser?: boolean;
  // The maintenance window in force right now; expired windows are filtered out by the caller.
  maintenance?: ServerMaintenance;
  personalAuth: PersonalAuthState;
  // A shared server whose own connection is down.
  sharedConnectionFailed: boolean;
  // The user's most recent remembered failure for this server.
  failure?: { kind: UserServerFailureKind; at: number };
  // When the user disconnected personal OAuth.
  revokedAt?: string;
}

export interface ResolvedUserServerState {
  code: UserServerStatusCode;
  since?: string;
  // Overrides the default action of the code.
  action?: UserServerStatusAction;
  maintenance?: ServerMaintenance;
}

const iso = (at: number): string => new Date(at).toISOString();

// Reports the first state that applies. Pure: all inputs are gathered by the caller.
export const resolveUserServerState = (input: UserServerStateInputs): ResolvedUserServerState => {
  if (!input.selected) return { code: 'not_selected' };
  if (!input.enabled || input.pausedForUser) return { code: 'paused' };
  if (input.maintenance) return { code: 'maintenance', maintenance: input.maintenance };
  // A user who cannot hold personal credentials at all needs an administrator.
  if (input.personalAuth === 'ineligible') return { code: 'needs_auth', action: 'contact_admin' };
  if (input.personalAuth === 'missing') return { code: 'needs_auth' };
  if (input.personalAuth === 'revoked') return { code: 'revoked', since: input.revokedAt };
  const { failure } = input;
  if (failure?.kind === 'auth' && input.personalAuth === 'configured')
    return { code: 'credential_invalid', since: iso(failure.at) };
  if (input.sharedConnectionFailed) return { code: 'error' };
  if (failure)
    return {
      code: 'error',
      since: iso(failure.at),
      ...(failure.kind === 'misconfigured' ? { action: 'contact_admin' as const } : {}),
    };
  return { code: 'available' };
};

// Only states that follow from configuration stop a call before it reaches the upstream.
// The rest describe the last attempt or the shared connection, which the call itself
// (and its existing reconnect logic) is the best way to re-check.
export const BLOCKING_CODES: readonly UserServerStatusCode[] = [
  'not_selected',
  'paused',
  'maintenance',
  'needs_auth',
  'revoked',
];
// Reasons a call can be recorded as blocked: the blocking statuses and a tool above the
// user's own risk ceiling.
export const BLOCKED_ACTIVITY_CODES: readonly string[] = [...BLOCKING_CODES, 'risk_not_enabled'];
export const isBlockingStatus = (code: UserServerStatusCode): boolean =>
  BLOCKING_CODES.includes(code);

// Counts per state, with every state present so the shape never changes.
export const countUserServerStatuses = (
  codes: UserServerStatusCode[],
): Record<UserServerStatusCode, number> => {
  const counts = Object.fromEntries(USER_SERVER_STATUS_CODES.map((code) => [code, 0])) as Record<
    UserServerStatusCode,
    number
  >;
  for (const code of codes) counts[code]++;
  return counts;
};

// `empty`: nothing selected is usable. `partial`: something selected is usable and
// something selected is not. `normal`: everything selected is usable.
export const resolveEndpointState = (codes: UserServerStatusCode[]): WorkspaceEndpointState => {
  const selected = codes.filter((code) => code !== 'not_selected');
  const available = selected.filter((code) => code === 'available');
  if (!available.length) return 'empty';
  return available.length < selected.length ? 'partial' : 'normal';
};

const requestLanguage = (): string | undefined => {
  const context = RequestContextService.getInstance();
  const configured = context.getHeader('x-language') ?? context.getHeader('accept-language');
  const language = Array.isArray(configured) ? configured[0] : configured;
  return language?.split(',')[0].split(';')[0].trim() || undefined;
};

const DEFAULT_MESSAGES: Record<UserServerStatusCode, string> = {
  available: "'{{serverName}}' is available.",
  not_selected:
    "'{{serverName}}' is not in your workspace. Select it in your workspace to use it.",
  paused: "'{{serverName}}' is paused by an administrator.",
  maintenance: "'{{serverName}}' is under maintenance. Try again later.",
  needs_auth:
    "'{{serverName}}' needs your personal credentials or authorization. Connect it from your workspace.",
  revoked:
    "You disconnected your authorization for '{{serverName}}'. Reconnect it from your workspace.",
  credential_invalid:
    "Your credentials for '{{serverName}}' were rejected. Update them or reconnect from your workspace.",
  error: "'{{serverName}}' is currently unavailable. Try again later.",
};

// Fixed text only: upstream error bodies and URLs can carry secrets and never reach it.
export const buildUserServerStatus = (
  state: ResolvedUserServerState,
  serverName: string,
  language: string | undefined = requestLanguage(),
): UserServerStatus => {
  const until = state.code === 'maintenance' ? state.maintenance?.until : undefined;
  // A maintenance window with an end time has its own wording, so translations can place it.
  const key = until ? 'maintenanceUntil' : state.code;
  const defaultValue = (
    until
      ? "'{{serverName}}' is under maintenance until {{until}}. Try again later."
      : DEFAULT_MESSAGES[state.code]
  )
    .replace('{{serverName}}', serverName)
    .replace('{{until}}', until ?? '');
  let message =
    getT(language)(`workspace.status.${key}`, { serverName, until, defaultValue }) || defaultValue;
  // The one admin-written sentence a status carries: validated plain text, at most 200 chars.
  const note = state.code === 'maintenance' ? state.maintenance?.message : undefined;
  if (note) message = `${message} ${note}`;
  return {
    code: state.code,
    message,
    action: state.action !== undefined ? state.action : USER_SERVER_STATUS_ACTIONS[state.code],
    ...(state.since ? { since: state.since } : {}),
    ...(until ? { until } : {}),
  };
};

// Why a call was refused when its tool is above the level the user allows on the server.
export const RISK_NOT_ENABLED_CODE = 'risk_not_enabled';
export const ENABLE_RISK_ACTION = 'enable_risk';

const RISK_NOT_ENABLED_DEFAULTS: Record<'write' | 'external', string> = {
  write:
    "'{{toolName}}' changes your data on '{{serverName}}', which your workspace does not allow yet. Allow changes to your data for '{{serverName}}' in your workspace to use it.",
  external:
    "'{{toolName}}' can act in ways other people can see on '{{serverName}}', which your workspace does not allow yet. Allow actions others can see for '{{serverName}}' in your workspace to use it.",
};

// Fixed, translated text. The tool name is the caller's own string echoed back, as in the
// generic "not available" error.
export const buildRiskNotEnabledMessage = (
  serverName: string,
  toolName: string,
  risk: 'write' | 'external',
  language: string | undefined = requestLanguage(),
): string => {
  const defaultValue = RISK_NOT_ENABLED_DEFAULTS[risk]
    .split('{{toolName}}')
    .join(toolName)
    .split('{{serverName}}')
    .join(serverName);
  return (
    getT(language)(`workspace.status.riskNotEnabled.${risk}`, {
      serverName,
      toolName,
      defaultValue,
    }) || defaultValue
  );
};

type StatusUser = { username: string; isAdmin?: boolean; credentialEligible?: boolean };

// Whether the user has supplied what a personal-auth server needs.
export const getPersonalAuthState = async (
  user: StatusUser,
  serverName: string,
  config: ServerConfig,
): Promise<PersonalAuthState> => {
  if (!hasPersonalAuthentication(config)) return 'not_required';
  if (user.credentialEligible === false) return 'ineligible';
  try {
    if (hasCredentialTemplate(config)) {
      return (await getCredentialBindingStatus(serverName, user.username, config)).configured
        ? 'configured'
        : 'missing';
    }
    const { hasPersonalOAuth, PersonalOAuthContext } = await import('./personalOAuthService.js');
    if (hasPersonalOAuth(config)) {
      const personal = await PersonalOAuthContext.load(serverName, user.username, config);
      if (personal.config.oauth.accessToken) return 'configured';
      return personal.disconnected ? 'revoked' : 'missing';
    }
  } catch {
    return 'missing';
  }
  return 'configured';
};

// On-demand servers sleep while idle, so a disconnected one is not a fault.
const isSharedConnectionDown = (config: ServerConfig, info?: ServerInfo): boolean => {
  if (!info || hasPersonalAuthentication(config) || config.startOnDemand) return false;
  return (
    info.status === 'oauth_required' || (info.status === 'disconnected' && Boolean(info.error))
  );
};

export interface UserServerStatusSubject {
  name: string;
  config: ServerConfig;
  enabled: boolean;
  // The shared runtime, when one exists.
  info?: ServerInfo;
}

// Whether an administrator has made this server unusable for the requester: paused for them
// alone, or in maintenance (administrators bypass maintenance so they can test; a request
// without a user, such as a system key, does not). The global `enabled` flag is checked separately.
export const isAdminBlockedForUser = (
  config: ServerConfig | undefined,
  user: { username?: string; isAdmin?: boolean } | null | undefined,
  now: number = Date.now(),
): boolean =>
  isPausedForUser(config, user?.username) ||
  (user?.isAdmin !== true && Boolean(getActiveMaintenance(config, now)));

// Gathers the inputs for one (user, server) pair. `selected` is whether the server counts
// as part of the user's scope on this route. `personalAuth` may be passed when the caller
// already looked it up.
export const getUserServerStatus = async (options: {
  user: StatusUser;
  subject: UserServerStatusSubject;
  selected: boolean;
  personalAuth?: PersonalAuthState;
  language?: string;
  // Injectable clock for maintenance expiry.
  now?: number;
}): Promise<UserServerStatus> => {
  const { user, subject, selected } = options;
  // Credentials are only worth looking up for a server that is otherwise in play.
  const personalAuth =
    options.personalAuth ??
    (selected &&
    subject.enabled &&
    !isAdminBlockedForUser(subject.config, user, options.now)
      ? await getPersonalAuthState(user, subject.name, subject.config)
      : 'not_required');
  const revokedAt =
    personalAuth === 'revoked' ? await readRevokedAt(user.username, subject) : undefined;
  const state = resolveUserServerState({
    selected,
    enabled: subject.enabled,
    pausedForUser: isPausedForUser(subject.config, user.username),
    maintenance: user.isAdmin ? undefined : getActiveMaintenance(subject.config, options.now),
    personalAuth,
    sharedConnectionFailed: isSharedConnectionDown(subject.config, subject.info),
    failure: getUserServerFailure(user.username, subject.name),
    revokedAt,
  });
  return buildUserServerStatus(state, subject.name, options.language);
};

const readRevokedAt = async (
  username: string,
  subject: UserServerStatusSubject,
): Promise<string | undefined> => {
  try {
    const { getCredentialBindingDao } = await import('../dao/DaoFactory.js');
    return (await getCredentialBindingDao().get(subject.name, username))?.updatedAt;
  } catch {
    return undefined;
  }
};

export type RuntimeFailureClass = 'ignore' | 'auth' | 'misconfigured' | 'runtime';

// Classifies a failure to prepare the user's personal runtime. Only the upstream refusing
// the credential at the transport level counts as a rejected credential. A missing binding
// is already reported from configuration, a binding that changed mid-request heals on
// retry, and any other binding error (a broken credential store, an invalid template) is
// the administrator's to fix.
export const classifyRuntimePreparationFailure = (error: unknown): RuntimeFailureClass => {
  if (error instanceof MissingCredentialError) return 'ignore';
  if (error instanceof CredentialBindingConflictError) return 'runtime';
  if (error instanceof CredentialBindingError) return 'misconfigured';
  if ((error as { authRejected?: unknown } | null)?.authRejected === true) return 'auth';
  return 'runtime';
};

// Remembers that preparing the user's personal runtime failed. Only the class is kept;
// error text can contain secrets. Active only under Workspace Mode.
//
// A credential-template server is reached with each user's own values, but a refusal can
// also come from the server's shared setup (a static header, a wrong URL). When two or more
// distinct users are refused by the same server within a short window, it is treated as
// that server's misconfiguration for all of them. Personal OAuth refusals stay per user.
export const reportRuntimePreparationFailure = (
  username: string | undefined,
  serverName: string,
  error: unknown,
  now: number = Date.now(),
  config?: ServerConfig,
): void => {
  if (!username || !isWorkspaceEnabled()) return;
  const kind = classifyRuntimePreparationFailure(error);
  if (kind === 'ignore') return;
  if (kind === 'auth' && hasCredentialTemplate(config)) {
    const users = noteAuthRejection(username, serverName, now);
    if (users.length >= 2) {
      for (const user of users) recordUserServerFailure(user, serverName, 'misconfigured', now);
      return;
    }
  }
  recordUserServerFailure(username, serverName, kind, now);
};

const STRUCTURED_CODES = ['CREDENTIAL_INVALID', 'CONNECTION_REVOKED'];

// An upstream can say, inside a tool result, that the user's credential is no longer
// valid: `{"error":"CREDENTIAL_INVALID"}` or `{"error":"CONNECTION_REVOKED"}` as the
// result's structured content or as the JSON text of a content item.
export const isStructuredCredentialError = (result: unknown): boolean => {
  if (!result || typeof result !== 'object') return false;
  const { isError, content, structuredContent } = result as {
    isError?: unknown;
    content?: unknown;
    structuredContent?: { error?: unknown };
  };
  if (isError !== true) return false;
  if (STRUCTURED_CODES.includes(structuredContent?.error as string)) return true;
  if (!Array.isArray(content)) return false;
  return content.some((item) => {
    if (item?.type !== 'text' || typeof item.text !== 'string') return false;
    try {
      const parsed = JSON.parse(item.text) as { error?: unknown } | null;
      return STRUCTURED_CODES.includes(parsed?.error as string);
    } catch {
      return false;
    }
  });
};

// Tells one user's MCP sessions that their lists changed. Only under Workspace Mode.
export const notifyWorkspaceUser = async (username: string): Promise<void> => {
  if (!isWorkspaceEnabled()) return;
  try {
    const { notifyUserListsChanged } = await import('./mcpService.js');
    notifyUserListsChanged(username);
  } catch (error) {
    logger.warn('Failed to notify user sessions of a change', { error });
  }
};

// A tool result reported the user's credential as no longer valid.
export const reportCredentialRejected = (
  username: string | undefined,
  serverName: string,
  now: number = Date.now(),
): void => {
  if (!username || !isWorkspaceEnabled()) return;
  recordUserServerFailure(username, serverName, 'auth', now);
};

// A successful call shows an earlier failure has healed.
export const reportUpstreamSuccess = (username: string | undefined, serverName: string): void => {
  if (!username || !isWorkspaceEnabled()) return;
  clearUserServerFailure(username, serverName);
};

// A runtime was prepared, which heals a remembered runtime failure but says nothing about
// whether the credential still works.
export const reportRuntimeReady = (username: string | undefined, serverName: string): void => {
  if (!username || !isWorkspaceEnabled()) return;
  clearUserServerFailure(username, serverName, 'runtime');
  clearUserServerFailure(username, serverName, 'misconfigured');
};
