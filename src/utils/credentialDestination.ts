import type { ServerConfig } from '../types/index.js';
import { canonicalJson } from './canonicalJson.js';
import { credentialSlotId } from './credentialTemplate.js';

// The parts of a server declaration that decide where a stored personal credential value
// is sent. A binding made against one destination must not be injected into another.
//
// Included: transport; URL (scheme, host, port, path, query); header names and values
// except the headers a slot fills; command, args (slot placeholders as written) and env
// except the variables a slot fills (env can redirect traffic, e.g. HTTPS_PROXY); the
// proxychains routing; the OpenAPI document and its security declaration; the slots'
// targets and names.
//
// Not included: description, visibility, sharing, enabled, tools/prompts/resources
// settings, request options (timeouts), keep-alive, on-demand and idle settings,
// passthrough header names, per-session behaviour, workspace fields (pause, maintenance,
// tool risk), owner, and the slots' labels and URL `allowed` lists (a stored URL value
// must still be on the list to be used, so widening the list moves nothing).
//
// Pass the config as the runtime builds it: the stored definition after `expandServerConfig`,
// always (see credentialBindingService.canonicalDestination).
// ServerConfig has no working directory, TLS or agent options today; add any such
// option here when it is introduced.
export const credentialDestinationDeclaration = (config: ServerConfig): unknown => {
  const slots = config.credentialTemplate ?? [];
  const filled = (target: 'env' | 'headers') =>
    new Set(
      slots
        .filter((slot) => slot.target === target)
        .map((slot) => (target === 'headers' ? slot.name.toLowerCase() : slot.name)),
    );
  const filledEnv = filled('env');
  const filledHeaders = filled('headers');
  const env = Object.entries(config.env ?? {}).filter(([name]) => !filledEnv.has(name));
  // Every header is kept as sent, so a hidden duplicate that differs only in case cannot
  // change what is sent without changing the fingerprint. Sorted so key order is irrelevant.
  const headers = Object.entries(config.headers ?? {})
    .filter(([name]) => !filledHeaders.has(name.toLowerCase()))
    .sort(([a], [b]) => {
      const folded = a.toLowerCase().localeCompare(b.toLowerCase());
      return folded || (a < b ? -1 : a > b ? 1 : 0);
    });
  const stdio = config.type === 'stdio' || (!config.type && !!config.command && !config.url);
  const openapi = config.openapi && {
    url: config.openapi.url,
    schema: config.openapi.schema,
    security: config.openapi.security,
    specSecurity: config.openapi.specSecurity,
  };
  return {
    type: config.type ?? (stdio ? 'stdio' : 'sse'),
    url: config.url,
    headers,
    command: config.command,
    args: config.args,
    env: Object.fromEntries(env),
    proxy: config.proxy,
    openapi,
    slots: slots
      .map((slot) =>
        slot.target === 'headers' ? `headers.${slot.name.toLowerCase()}` : credentialSlotId(slot),
      )
      .sort(),
  };
};

// Fingerprint of a binding whose server no longer exists, or that belongs to an earlier server
// of the same name. It matches no declaration.
export const ORPHANED_FINGERPRINT = 'v1:orphaned';

export const canonicalCredentialDestination = (config: ServerConfig): string =>
  canonicalJson(credentialDestinationDeclaration(config));
