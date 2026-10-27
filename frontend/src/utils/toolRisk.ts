import type { ToolRiskLevel, WorkspaceServer } from '../types';

/** Ordered by how far a tool's effects reach. */
export const TOOL_RISK_LEVELS: readonly ToolRiskLevel[] = ['read', 'write', 'external'];

export const riskRank = (level: ToolRiskLevel): number => TOOL_RISK_LEVELS.indexOf(level);

export const isToolRiskLevel = (value: unknown): value is ToolRiskLevel =>
  typeof value === 'string' && (TOOL_RISK_LEVELS as readonly string[]).includes(value);

/** A level the user can choose: not above what the administrator allows on the service. */
export const isRiskChoiceAllowed = (level: ToolRiskLevel, maxAllowed: ToolRiskLevel): boolean =>
  riskRank(level) <= riskRank(maxAllowed);

/** Tools within the ceiling: what the user's endpoint exposes. */
export const countWithinCeiling = (
  counts: Record<ToolRiskLevel, number> | null,
  ceiling: ToolRiskLevel,
): number =>
  !counts
    ? 0
    : TOOL_RISK_LEVELS.filter((level) => riskRank(level) <= riskRank(ceiling)).reduce(
        (sum, level) => sum + (counts[level] || 0),
        0,
      );

/** Tools the administrator allows but the user's ceiling hides. */
export const countHiddenByCeiling = (
  counts: Record<ToolRiskLevel, number> | null,
  ceiling: ToolRiskLevel,
): number =>
  !counts
    ? 0
    : TOOL_RISK_LEVELS.reduce((sum, level) => sum + (counts[level] || 0), 0) -
      countWithinCeiling(counts, ceiling);

/** Hidden tools across the services the user selected: what a newly enabled mode takes away. */
export const countHiddenTools = (servers: readonly WorkspaceServer[]): number =>
  servers
    // A service whose tools are not known yet hides nothing we can count.
    .filter((server) => server.selected && server.riskCounts)
    .reduce((sum, server) => sum + countHiddenByCeiling(server.riskCounts, server.riskCeiling), 0);

/**
 * The ceiling a service shows after a choice is applied locally: the tool count follows the
 * choice at once, before the server confirms.
 */
export const applyRiskCeiling = (
  servers: readonly WorkspaceServer[],
  name: string,
  riskCeiling: ToolRiskLevel,
): WorkspaceServer[] =>
  servers.map((server) =>
    server.name === name
      ? {
          ...server,
          riskCeiling,
          riskCeilingIsDefault: false,
          toolCount: server.riskCounts ? countWithinCeiling(server.riskCounts, riskCeiling) : null,
        }
      : server,
  );

export interface RiskDeps {
  save: (name: string, riskCeiling: ToolRiskLevel) => Promise<void>;
  update: (updater: (servers: WorkspaceServer[]) => WorkspaceServer[]) => void;
}

/**
 * Applies the choice in the UI first, then saves it; restores that service's previous choice if
 * saving fails. Resolves true when the change was saved.
 */
export const changeRiskCeiling = async (
  server: Pick<WorkspaceServer, 'name' | 'riskCeiling' | 'riskCeilingIsDefault'>,
  riskCeiling: ToolRiskLevel,
  deps: RiskDeps,
): Promise<boolean> => {
  const previous = server.riskCeiling;
  const wasDefault = server.riskCeilingIsDefault === true;
  // Choosing the level that is currently only a default still records the choice.
  if (previous === riskCeiling && !wasDefault) return true;
  deps.update((servers) => applyRiskCeiling(servers, server.name, riskCeiling));
  try {
    await deps.save(server.name, riskCeiling);
    return true;
  } catch {
    deps.update((servers) =>
      applyRiskCeiling(servers, server.name, previous).map((entry) =>
        entry.name === server.name ? { ...entry, riskCeilingIsDefault: wasDefault } : entry,
      ),
    );
    return false;
  }
};

/** What an administrator can pick for a tool: its computed level or higher. */
export const overrideChoices = (computed: ToolRiskLevel): ToolRiskLevel[] =>
  TOOL_RISK_LEVELS.filter((level) => riskRank(level) >= riskRank(computed));

/** The default level for users can never exceed the cap: lowering the cap pulls it down. */
export const clampDefaultToCap = (
  defaultValue: ToolRiskLevel,
  cap: ToolRiskLevel,
): ToolRiskLevel => (riskRank(defaultValue) > riskRank(cap) ? cap : defaultValue);
