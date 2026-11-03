import type { ChannelRow, Sources } from "../connect/sources.ts";

export interface Identity {
  readonly sourceId: string;
  readonly channelId: string;
}

export interface Entry extends Identity {
  readonly title: string;
}

export interface ChannelList {
  readonly id: string;
  readonly name: string;
  readonly entries: readonly Entry[];
}

export interface Draft {
  readonly id: string;
  readonly snapshot: string;
  readonly entries: readonly Entry[];
}

export type Resolution =
  | { readonly kind: "listed"; readonly row: ChannelRow }
  | { readonly kind: "loading" | "failed" | "removed" | "missing" | "ambiguous" };

export const same = (a: Identity, b: Identity) =>
  a.sourceId === b.sourceId && a.channelId === b.channelId;

/** ChannelRow keys are sourceId + ':' + the provider id, which may itself contain colons. */
export function identity(row: ChannelRow): Entry {
  const prefix = `${row.sourceId}:`;

  if (!row.key.startsWith(prefix) || row.key.length === prefix.length) throw new Error("identity");

  return { sourceId: row.sourceId, channelId: row.key.slice(prefix.length), title: row.title };
}

/** Never resolves by title, row position, or an arbitrary first duplicate. */
export function resolve(entry: Identity, sources: Sources): Resolution {
  if (sources.kind === "restoring") return { kind: "loading" };
  const owners = sources.sources.filter((source) => source.id === entry.sourceId);

  if (owners.length > 1) return { kind: "ambiguous" };
  const owner = owners[0];

  if (!owner) return { kind: "removed" };

  if (owner.channels.kind !== "ready") return { kind: owner.channels.kind };

  const rows = owner.channels.rows.filter(
    (row) => row.sourceId === entry.sourceId && row.key === `${entry.sourceId}:${entry.channelId}`,
  );

  return rows.length === 1
    ? { kind: "listed", row: rows[0]! }
    : { kind: rows.length ? "ambiguous" : "missing" };
}

/** Includes current resolution, so provider changes during editing refuse the entire save. */
export const snapshot = (list: ChannelList, sources: Sources) =>
  JSON.stringify([list.id, list.entries, list.entries.map((entry) => resolve(entry, sources))]);

export const draftOf = (list: ChannelList, sources: Sources): Draft => ({
  id: list.id,
  snapshot: snapshot(list, sources),
  entries: [...list.entries],
});

export function move(draft: Draft, index: number, offset: -1 | 1): Draft {
  const entries = [...draft.entries];
  const other = index + offset;

  if (index < 0 || other < 0 || index >= entries.length || other >= entries.length) return draft;
  [entries[index], entries[other]] = [entries[other]!, entries[index]!];

  return { ...draft, entries };
}

export const remove = (draft: Draft, index: number): Draft => ({
  ...draft,
  entries: draft.entries.filter((_, at) => at !== index),
});
