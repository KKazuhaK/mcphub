// The tool, prompt and resource names a user's own principal runtime last listed for a
// server. A server that needs personal credentials has no shared cached lists, so this is
// how a call for one of its names can be recognized as addressed to it. Entries only ever
// come from the requesting user's own runtime and are only matched for that user.

export interface ListedNamesSource {
  tools?: Array<{ name: string }>;
  prompts?: Array<{ name: string }>;
  resources?: Array<{ uri: string }>;
}

type Kind = 'tools' | 'prompts' | 'resources';

export const MAX_LISTED_ENTRIES = 2000;
export const MAX_LISTED_NAMES = 1000;

const entries = new Map<string, Record<Kind, Set<string>>>();

const keyOf = (username: string, serverName: string): string =>
  JSON.stringify([username, serverName]);

// A kind that came back empty (for example a tools-only listing) keeps its earlier names.
export const recordUserListedNames = (
  username: string,
  serverName: string,
  source: ListedNamesSource,
): void => {
  const key = keyOf(username, serverName);
  const entry = entries.get(key) ?? {
    tools: new Set<string>(),
    prompts: new Set<string>(),
    resources: new Set<string>(),
  };
  const lists: Record<Kind, string[]> = {
    tools: (source.tools ?? []).map((item) => item.name),
    prompts: (source.prompts ?? []).map((item) => item.name),
    resources: (source.resources ?? []).map((item) => item.uri),
  };
  for (const kind of Object.keys(lists) as Kind[])
    if (lists[kind].length) entry[kind] = new Set(lists[kind].slice(0, MAX_LISTED_NAMES));
  // Re-inserting moves the entry to the end, so the oldest entry is the eviction candidate.
  entries.delete(key);
  entries.set(key, entry);
  while (entries.size > MAX_LISTED_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
};

export const hasUserListedName = (
  username: string,
  serverName: string,
  kind: Kind,
  name: string,
): boolean => entries.get(keyOf(username, serverName))?.[kind].has(name) ?? false;

// With neither field set, every entry is removed.
export const clearUserListedNames = (
  filter: { username?: string; serverName?: string } = {},
): void => {
  for (const key of [...entries.keys()]) {
    const [username, serverName] = JSON.parse(key) as [string, string];
    if (filter.username !== undefined && filter.username !== username) continue;
    if (filter.serverName !== undefined && filter.serverName !== serverName) continue;
    entries.delete(key);
  }
};

export const getUserListedEntryCount = (): number => entries.size;
