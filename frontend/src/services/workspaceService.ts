import type {
  WorkspaceClient,
  WorkspaceEndpoints,
  WorkspaceServer,
  WorkspaceSummary,
} from '../types';
import { WorkspaceApiError, isWorkspaceDisabledMessage } from '../utils/workspace';
import { apiDelete, apiGet, apiPost, apiPut, type ApiResponse } from '../utils/fetchInterceptor';

// Unwraps `{ success, data }` and turns a failed envelope into an Error.
const unwrap = <T>(result: ApiResponse<T>, _context: string): T => {
  if (!result?.success) {
    throw new WorkspaceApiError(result?.message || '', isWorkspaceDisabledMessage(result?.message));
  }
  return result.data as T;
};

export const fetchWorkspaceServers = async (): Promise<WorkspaceServer[]> =>
  unwrap(await apiGet<ApiResponse<WorkspaceServer[]>>('/workspace/servers'), 'servers');

export const fetchWorkspaceSummary = async (): Promise<WorkspaceSummary> =>
  unwrap(await apiGet<ApiResponse<WorkspaceSummary>>('/workspace/summary'), 'summary');

export const fetchWorkspaceEndpoints = async (): Promise<WorkspaceEndpoints> =>
  unwrap(await apiGet<ApiResponse<WorkspaceEndpoints>>('/workspace/endpoints'), 'endpoints');

export const saveServerSelection = async (name: string, selected: boolean): Promise<void> => {
  unwrap(
    await apiPut<ApiResponse>(`/workspace/servers/${encodeURIComponent(name)}/selection`, {
      selected,
    }),
    'selection',
  );
};

export const fetchWorkspaceClients = async (): Promise<WorkspaceClient[]> =>
  unwrap(await apiGet<ApiResponse<WorkspaceClient[]>>('/workspace/clients'), 'clients');

export const revokeWorkspaceClient = async (client: WorkspaceClient): Promise<void> => {
  unwrap(
    await apiDelete<ApiResponse>(
      `/workspace/clients/${client.kind}/${encodeURIComponent(client.id)}`,
    ),
    'revoke',
  );
};

export const revokeAllWorkspaceClients = async (): Promise<void> => {
  unwrap(await apiDelete<ApiResponse>('/workspace/clients'), 'revoke');
};

/** Names of shared servers that have personal credential slots (the Credentials page list). */
export const fetchCredentialServerNames = async (): Promise<Set<string>> => {
  const bindings = unwrap(
    await apiGet<ApiResponse<{ serverName: string }[]>>('/credentials'),
    'credentials',
  );
  return new Set((bindings || []).map((binding) => binding.serverName));
};

/** Starts (or refreshes) the personal OAuth flow; resolves with the authorization URL if any. */
export const startPersonalOAuth = async (name: string): Promise<string | undefined> => {
  const data = unwrap(
    await apiPost<ApiResponse<{ authorizationUrl?: string }>>(
      `/servers/${encodeURIComponent(name)}/oauth/personal`,
      {},
    ),
    'oauth',
  );
  return data?.authorizationUrl;
};
