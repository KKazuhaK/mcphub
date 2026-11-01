import {
  hasPersonalOAuth,
  resolvePersonalOAuth,
  personalOAuthContexts,
  withPersonalOAuthLock,
} from './personalOAuthService.js';
import { getServerDao } from '../dao/DaoFactory.js';
import { credentialBindingEvents, resolveCredentialBinding } from './credentialBindingService.js';
import { authorizationService, type RequestPrincipal } from './authorizationService.js';
import {
  CredentialBindingConflictError,
  MissingCredentialError,
  hasPersonalAuthentication,
} from '../utils/credentialTemplate.js';
import type { CapabilityScope } from './capabilitySnapshotService.js';
import type { ServerConfig, ServerInfo } from '../types/index.js';

export const MAX_KNOWN_TOOL_ENTRIES = 2000;

// The only parts of a tool the workspace summary reads (its name and the risk annotations);
// schemas and descriptions are not kept.
export type KnownTool = Pick<NonNullable<ServerInfo['tools']>[number], 'name' | 'annotations'>;

interface RuntimeEntry {
  serverName: string;
  username: string;
  revision: string;
  promise: Promise<ServerInfo>;
  valid: boolean;
  info?: ServerInfo;
  active: number;
  timer?: NodeJS.Timeout;
}

/** Reuses children across MCP sessions, but never across authenticated principals. */
export class PrincipalRuntimeService {
  private readonly entries = new Map<string, RuntimeEntry>();
  // The last tool list each principal saw, kept past idle shutdown. Entries carry the
  // revision they were listed under and are dropped when credentials or the server change.
  private readonly knownTools = new Map<string, { revision: string; tools: KnownTool[] }>();

  constructor(
    private readonly connect: (
      name: string,
      config: ServerConfig,
      scope?: CapabilityScope,
    ) => Promise<ServerInfo>,
    private readonly close: (info: ServerInfo) => void,
    private readonly restoreTools?: (
      name: string,
      config: ServerConfig,
      scope: CapabilityScope,
    ) => Promise<ServerInfo | undefined>,
  ) {
    credentialBindingEvents.on('invalidate', (filter) => this.invalidate(filter));
  }

  invalidate(filter: { serverName?: string; username?: string } = {}): void {
    for (const key of [...this.knownTools.keys()]) {
      const [name, user] = JSON.parse(key) as [string, string];
      if (filter.serverName !== undefined && name !== filter.serverName) continue;
      if (filter.username !== undefined && user !== filter.username) continue;
      this.knownTools.delete(key);
    }
    this.close_(filter);
  }

  // Closes matching runtimes; the remembered tool lists are left alone.
  private close_(filter: { serverName?: string; username?: string }): void {
    for (const [key, entry] of this.entries) {
      if (filter.serverName !== undefined && entry.serverName !== filter.serverName) continue;
      if (filter.username !== undefined && entry.username !== filter.username) continue;
      entry.valid = false;
      clearTimeout(entry.timer);
      this.entries.delete(key);
      void entry.promise.then((info) => this.close(info)).catch(() => undefined);
    }
  }

  /**
   * The tools this principal last listed for a server, read without starting anything and
   * without touching snapshots or embeddings. Survives the idle shutdown of the runtime, but
   * not a change to the credentials or the server definition it was listed under. Undefined
   * when nothing valid is remembered. Never consults another principal's list.
   */
  async peekTools(
    serverName: string,
    principal: RequestPrincipal,
  ): Promise<KnownTool[] | undefined> {
    if (principal.credentialEligible === false) return undefined;
    const key = JSON.stringify([serverName, principal.username]);
    const known = this.knownTools.get(key);
    if (!known) return undefined;
    const currentRevision = async () => {
      const definition = await getServerDao().findById(serverName);
      if (
        !definition ||
        definition.enabled === false ||
        !hasPersonalAuthentication(definition) ||
        !authorizationService.can('server.invoke', definition, principal)
      ) {
        return undefined;
      }
      const resolver = hasPersonalOAuth(definition)
        ? resolvePersonalOAuth
        : resolveCredentialBinding;
      const resolved = await resolver(serverName, principal.username, definition);
      return JSON.stringify([JSON.stringify(definition), resolved.revision]);
    };
    const first = await currentRevision();
    if (first === undefined || first !== known.revision) {
      if (this.knownTools.get(key) === known) this.knownTools.delete(key);
      return undefined;
    }
    // A rotation or edit may have landed while the checks above were awaited.
    if ((await currentRevision()) !== first || this.knownTools.get(key) !== known) return undefined;
    return known.tools;
  }

  private remember(key: string, revision: string, tools: ServerInfo['tools']): void {
    // Re-inserting moves the entry to the end, so the oldest one is evicted first.
    this.knownTools.delete(key);
    this.knownTools.set(key, {
      revision,
      tools: (tools ?? []).map(({ name, annotations }) =>
        annotations ? { name, annotations: { ...annotations } } : { name },
      ),
    });
    while (this.knownTools.size > MAX_KNOWN_TOOL_ENTRIES) {
      const oldest = this.knownTools.keys().next().value;
      if (oldest === undefined) break;
      this.knownTools.delete(oldest);
    }
  }

  async acquire(
    serverName: string,
    principal: RequestPrincipal,
    toolsOnly = false,
  ): Promise<{ info: ServerInfo; release: () => void }> {
    if (principal.credentialEligible === false)
      throw new MissingCredentialError('Personal authentication is required');
    const definition = await getServerDao().findById(serverName);
    if (
      !definition ||
      definition.enabled === false ||
      !hasPersonalAuthentication(definition) ||
      !authorizationService.can('server.invoke', definition, principal)
    ) {
      throw new CredentialBindingConflictError('Server not available');
    }
    // These snapshots only detect runtime changes in memory; they are never persisted or logged.
    const definitionSnapshot = JSON.stringify(definition);
    const resolver = hasPersonalOAuth(definition) ? resolvePersonalOAuth : resolveCredentialBinding;
    // Resolvers take the stored definition and expand it themselves, once, so every
    // resolution (including the re-checks after a connect) fingerprints the same declaration.
    if (toolsOnly && this.restoreTools) {
      const resolved = await resolver(serverName, principal.username, definition);
      const existing = this.entries.get(JSON.stringify([serverName, principal.username]));
      const live =
        existing?.valid &&
        existing.revision === JSON.stringify([definitionSnapshot, resolved.revision]) &&
        existing.info?.status !== 'disconnected';
      const cached = live
        ? undefined
        : await this.restoreTools(serverName, resolved.config, {
            username: principal.username,
            revision: resolved.revision,
          });
      if (cached) {
        const latest = await resolver(serverName, principal.username, definition);
        const current = await getServerDao().findById(serverName);
        if (latest.revision !== resolved.revision || JSON.stringify(current) !== definitionSnapshot)
          throw new CredentialBindingConflictError(
            'Personal credentials or server configuration changed; retry the request',
          );
        this.remember(
          JSON.stringify([serverName, principal.username]),
          JSON.stringify([definitionSnapshot, resolved.revision]),
          cached.tools,
        );
        return { info: cached, release: () => {} };
      }
    }
    const prepare = async () => {
      const resolved = await resolver(serverName, principal.username, definition);
      const revision = JSON.stringify([definitionSnapshot, resolved.revision]);
      const key = JSON.stringify([serverName, principal.username]);
      let entry = this.entries.get(key);
      if (entry && (entry.revision !== revision || entry.info?.status === 'disconnected')) {
        this.close_({ serverName, username: principal.username });
        entry = undefined;
      }
      if (!entry) {
        const created: RuntimeEntry = {
          serverName,
          username: principal.username,
          // This context advances only after its own successful CAS writes. External
          // binding changes still differ from its version and invalidate the runtime.
          get revision() {
            return JSON.stringify([
              definitionSnapshot,
              personalOAuthContexts.get(resolved.config)?.version || resolved.revision,
            ]);
          },
          valid: true,
          active: 0,
          promise: undefined!,
        };
        this.entries.set(key, created);
        created.promise = (async () => {
          let info: ServerInfo | undefined;
          try {
            info = await this.connect(serverName, resolved.config, {
              username: principal.username,
              revision: resolved.revision,
            });
            // A rotation/deletion may have raced the initial read or async handshake.
            const verify = async () => {
              const latest = await resolver(serverName, principal.username, definition);
              const currentDefinition = await getServerDao().findById(serverName);
              if (
                !created.valid ||
                latest.revision !==
                  (personalOAuthContexts.get(resolved.config)?.version || resolved.revision) ||
                JSON.stringify(currentDefinition) !== definitionSnapshot
              ) {
                throw new CredentialBindingConflictError(
                  'Personal credentials or server configuration changed; retry the request',
                );
              }
            };
            if (hasPersonalOAuth(definition))
              await withPersonalOAuthLock(serverName, principal.username, verify);
            else await verify();
            created.info = info;
            return info;
          } catch (error) {
            if (info) this.close(info);
            if (this.entries.get(key) === created) this.entries.delete(key);
            created.valid = false;
            throw error;
          }
        })();
        entry = created;
      }
      return entry;
    };
    const entry = hasPersonalOAuth(definition)
      ? await withPersonalOAuthLock(serverName, principal.username, prepare)
      : await prepare();
    clearTimeout(entry.timer);
    entry.active += 1;
    const held = entry;
    const memoryKey = JSON.stringify([serverName, principal.username]);
    const release = () => {
      held.active -= 1;
      // The list as of the end of this use, under the revision the runtime is valid for.
      if (held.valid && held.info) this.remember(memoryKey, held.revision, held.info.tools);
      if (held.active === 0 && held.valid) {
        const idleMs =
          definition.idleTimeoutMs && definition.idleTimeoutMs > 0
            ? definition.idleTimeoutMs
            : 300_000;
        held.timer = setTimeout(
          () => this.close_({ serverName, username: principal.username }),
          idleMs,
        );
        held.timer.unref?.();
      }
    };
    try {
      const info = await held.promise;
      if (!held.valid)
        throw new CredentialBindingConflictError('Personal credentials changed; retry the request');
      return { info, release };
    } catch (error) {
      release();
      throw error;
    }
  }
}
