import type { ServerConfig, Tool, ToolRiskLevel } from '../types/index.js';
import { logger } from './logger.js';
import { ServerConfigValidationError } from './serverConfigValidation.js';
import { findByToolKey } from './toolConfig.js';

// Ordered by how far a tool's effects reach.
export const TOOL_RISK_LEVELS: readonly ToolRiskLevel[] = ['read', 'write', 'external'];

const MAX_OVERRIDE_ENTRIES = 5000;
const MAX_TOOL_KEY_LENGTH = 512;

export const isToolRiskLevel = (value: unknown): value is ToolRiskLevel =>
  typeof value === 'string' && (TOOL_RISK_LEVELS as readonly string[]).includes(value);

export const riskRank = (level: ToolRiskLevel): number => TOOL_RISK_LEVELS.indexOf(level);

export const maxRisk = (a: ToolRiskLevel, b: ToolRiskLevel): ToolRiskLevel =>
  riskRank(a) >= riskRank(b) ? a : b;

export const minRisk = (a: ToolRiskLevel, b: ToolRiskLevel): ToolRiskLevel =>
  riskRank(a) <= riskRank(b) ? a : b;

// Standard MCP annotations decide the level. Anything the upstream does not state counts as
// reaching others: `read` needs an explicit read-only hint, `write` an explicit statement that
// the tool does not act on an open world (changes only the user's own data).
export const classifyToolRisk = (tool: Pick<Tool, 'annotations'> | undefined): ToolRiskLevel => {
  const annotations = tool?.annotations;
  if (!annotations || typeof annotations !== 'object') return 'external';
  if (annotations.readOnlyHint === true) return 'read';
  if (annotations.openWorldHint === false) return 'write';
  return 'external';
};

// Stored values are not trusted: a malformed one is ignored, with one warning per distinct
// value, until an administrator edit fixes or clears it.
const warnedInvalid = new Set<string>();
const warnInvalidStored = (field: string, value: unknown): void => {
  const excerpt = (JSON.stringify(value) ?? String(value)).slice(0, 100);
  const key = `${field}:${excerpt}`;
  if (warnedInvalid.has(key) || warnedInvalid.size >= 100) return;
  warnedInvalid.add(key);
  logger.warn(`Ignoring invalid stored ${field}`, { excerpt });
};

/** The administrator's cap for a server; `external` (no cap) when unset or malformed. */
export const getMaxToolRisk = (
  config: Pick<ServerConfig, 'maxToolRisk'> | undefined,
): ToolRiskLevel => {
  const value = config?.maxToolRisk as unknown;
  if (value === undefined || value === null) return 'external';
  if (isToolRiskLevel(value)) return value;
  warnInvalidStored('maxToolRisk', value);
  return 'external';
};

/** The level the administrator assigned to a tool, when it is a valid one. */
export const getToolRiskOverride = (
  config: Pick<ServerConfig, 'toolRiskOverrides'> | undefined,
  serverName: string,
  toolName: string,
  runtimeNames: readonly string[] = [],
): ToolRiskLevel | undefined => {
  const overrides = config?.toolRiskOverrides as unknown;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return undefined;
  const value = findByToolKey(
    overrides as Record<string, unknown>,
    serverName,
    toolName,
    runtimeNames,
  );
  if (value === undefined || value === null) return undefined;
  if (isToolRiskLevel(value)) return value;
  warnInvalidStored('toolRiskOverrides', value);
  return undefined;
};

export interface ToolRiskInfo {
  computed: ToolRiskLevel;
  override?: ToolRiskLevel;
  effective: ToolRiskLevel;
}

/**
 * A tool's level: its computed one, raised (never lowered) by the administrator's override.
 * `runtimeNames` lists the server's runtime tool names, to keep one tool from reading another's
 * override under the key rule shared with per-tool settings.
 */
export const getToolRiskInfo = (
  serverName: string,
  tool: Pick<Tool, 'name' | 'annotations'>,
  config: Pick<ServerConfig, 'toolRiskOverrides'> | undefined,
  runtimeNames: readonly string[] = [],
  // False for a server whose annotations are not believed: every tool is `external`.
  trustAnnotations = true,
): ToolRiskInfo => {
  const computed = trustAnnotations ? classifyToolRisk(tool) : 'external';
  const override = getToolRiskOverride(config, serverName, tool.name, runtimeNames);
  return {
    computed,
    ...(override ? { override } : {}),
    effective: override ? maxRisk(computed, override) : computed,
  };
};

export const getEffectiveToolRisk = (
  serverName: string,
  tool: Pick<Tool, 'name' | 'annotations'>,
  config: Pick<ServerConfig, 'toolRiskOverrides'> | undefined,
  runtimeNames: readonly string[] = [],
  trustAnnotations = true,
): ToolRiskLevel =>
  getToolRiskInfo(serverName, tool, config, runtimeNames, trustAnnotations).effective;

/** The level a user starts at on a server: the administrator's default, else `read`. */
export const getDefaultUserRisk = (
  config: Pick<ServerConfig, 'defaultUserRisk'> | undefined,
): ToolRiskLevel => {
  const value = config?.defaultUserRisk as unknown;
  if (value === undefined || value === null) return 'read';
  if (isToolRiskLevel(value)) return value;
  warnInvalidStored('defaultUserRisk', value);
  return 'read';
};

/** `read` and `null` both mean "no default" and are stored as absent. */
export const normalizeDefaultUserRisk = (value: unknown): ToolRiskLevel | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isToolRiskLevel(value)) {
    throw new ServerConfigValidationError('defaultUserRisk must be one of read, write, external');
  }
  return value === 'read' ? undefined : value;
};

/** The default may not exceed the cap. */
export const assertDefaultWithinCap = (
  defaultUserRisk: ToolRiskLevel | undefined,
  maxToolRisk: ToolRiskLevel | undefined,
): void => {
  if (defaultUserRisk && riskRank(defaultUserRisk) > riskRank(maxToolRisk ?? 'external')) {
    throw new ServerConfigValidationError('defaultUserRisk cannot exceed maxToolRisk');
  }
};

/** `external` and `null` both mean "no cap" and are stored as absent. */
export const normalizeMaxToolRisk = (value: unknown): ToolRiskLevel | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isToolRiskLevel(value)) {
    throw new ServerConfigValidationError('maxToolRisk must be one of read, write, external');
  }
  return value === 'external' ? undefined : value;
};

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const normalizeToolRiskOverrides = (
  value: unknown,
): Record<string, ToolRiskLevel> | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ServerConfigValidationError('toolRiskOverrides must be an object');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_OVERRIDE_ENTRIES) {
    throw new ServerConfigValidationError(
      `toolRiskOverrides can list at most ${MAX_OVERRIDE_ENTRIES} tools`,
    );
  }
  const normalized: Record<string, ToolRiskLevel> = {};
  for (const [key, level] of entries) {
    const name = key.trim();
    if (!name || name.length > MAX_TOOL_KEY_LENGTH || UNSAFE_KEYS.has(name)) {
      throw new ServerConfigValidationError('toolRiskOverrides has an invalid tool name');
    }
    if (!isToolRiskLevel(level)) {
      throw new ServerConfigValidationError(
        'toolRiskOverrides levels must be one of read, write, external',
      );
    }
    normalized[name] = level;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
};

/**
 * An override may only raise a tool above the level its annotations give it. A tool the server
 * does not currently list cannot be checked here; its stored override is still clamped to
 * `max(computed, override)` whenever it is read.
 */
export const assertOverridesOnlyRaise = (
  overrides: Record<string, ToolRiskLevel> | undefined,
  serverName: string,
  tools: ReadonlyArray<Pick<Tool, 'name' | 'annotations'>>,
  trustAnnotations = true,
): void => {
  if (!overrides) return;
  const runtimeNames = tools.map((tool) => tool.name);
  for (const tool of tools) {
    const level = findByToolKey(overrides, serverName, tool.name, runtimeNames);
    const computed = trustAnnotations ? classifyToolRisk(tool) : 'external';
    if (level && riskRank(level) < riskRank(computed)) {
      throw new ServerConfigValidationError(
        `toolRiskOverrides can only raise a tool's risk level; '${tool.name}' is already ${computed}`,
      );
    }
  }
};

/** Whether two configurations differ in either tool-risk field. */
export type ToolRiskFields = Pick<
  ServerConfig,
  'maxToolRisk' | 'toolRiskOverrides' | 'defaultUserRisk'
>;
export const toolRiskChanged = (
  before: ToolRiskFields | undefined,
  after: ToolRiskFields | undefined,
): boolean =>
  (before?.maxToolRisk ?? 'external') !== (after?.maxToolRisk ?? 'external') ||
  (before?.defaultUserRisk ?? 'read') !== (after?.defaultUserRisk ?? 'read') ||
  JSON.stringify(sortedEntries(before?.toolRiskOverrides)) !==
    JSON.stringify(sortedEntries(after?.toolRiskOverrides));

const sortedEntries = (overrides: unknown): Array<[string, unknown]> =>
  overrides && typeof overrides === 'object'
    ? Object.entries(overrides as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    : [];
