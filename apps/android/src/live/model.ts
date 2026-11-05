import { preview, exampleId } from "../preview/session.ts";
import { channels } from "../preview/catalogue.ts";
import type { PlayIntent } from "../player/intent.ts";
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

/** One string per identity, for React keys and duplicate checks. */
export const keyOf = (entry: Identity) => JSON.stringify([entry.sourceId, entry.channelId]);

/** ChannelRow keys are sourceId + ':' + the provider id, which may itself contain colons. */
export function identity(row: ChannelRow): Entry {
  const prefix = `${row.sourceId}:`;

  if (!row.key.startsWith(prefix) || row.key.length === prefix.length) throw new Error("identity");

  return { sourceId: row.sourceId, channelId: row.key.slice(prefix.length), title: row.title };
}

interface SourceResolution {
  readonly fallback: Resolution;
  readonly rows: ReadonlyMap<string, Resolution>;
}

const resolutionCache = new WeakMap<Sources, Map<string, SourceResolution>>();

/** Index each immutable catalogue state once, retaining ambiguous owners and channel ids. */
function resolutions(sources: Extract<Sources, { kind: "ready" }>) {
  const cached = resolutionCache.get(sources);

  if (cached) return cached;

  const index = new Map<string, SourceResolution>();

  for (const source of sources.sources) {
    if (index.has(source.id)) {
      index.set(source.id, { fallback: { kind: "ambiguous" }, rows: new Map() });

      continue;
    }

    const rows = new Map<string, Resolution>();

    if (source.channels.kind === "ready")
      for (const row of source.channels.rows) {
        if (row.sourceId !== source.id) continue;

        rows.set(row.key, rows.has(row.key) ? { kind: "ambiguous" } : { kind: "listed", row });
      }

    index.set(source.id, {
      fallback: { kind: source.channels.kind === "ready" ? "missing" : source.channels.kind },
      rows,
    });
  }

  resolutionCache.set(sources, index);

  return index;
}

/** Never resolves by title, row position, or an arbitrary first duplicate. */
export function resolve(entry: Identity, sources: Sources): Resolution {
  if (preview.get() && entry.sourceId === exampleId) {
    const row = channels.find((r) => r.key === `${entry.sourceId}:${entry.channelId}`);

    return row ? { kind: "listed", row } : { kind: "missing" };
  }

  if (sources.kind === "restoring") return { kind: "loading" };
  const owner = resolutions(sources).get(entry.sourceId);

  return (
    owner?.rows.get(`${entry.sourceId}:${entry.channelId}`) ??
    owner?.fallback ?? { kind: "removed" }
  );
}

/** A row plays only its currently unique channel, with the catalogue's current title. */
export function playIntent(entry: Identity, sources: Sources): PlayIntent | null {
  const current = resolve(entry, sources);

  return current.kind === "listed" ? { ...identity(current.row), kind: "live" } : null;
}

/** Includes current resolution, so provider changes during editing refuse the entire save. */
export const snapshot = (list: ChannelList, sources: Sources) =>
  JSON.stringify([list.id, list.entries, list.entries.map((entry) => resolve(entry, sources))]);

export const draftOf = (list: ChannelList, sources: Sources): Draft => ({
  id: list.id,
  snapshot: snapshot(list, sources),
  entries: [...list.entries],
});

/**
 * Moves the entry at `index` past its nearest neighbour that `shown` keeps, so an entry an edit
 * screen doesn't show (Favourites' channels still loading) keeps its place. Unchanged at an end; `() => true`
 * moves it one place.
 */
export function step(
  draft: Draft,
  index: number,
  offset: -1 | 1,
  shown: (entry: Entry) => boolean,
): Draft {
  let other = index + offset;
  let next = draft.entries[other];

  while (next && !shown(next)) next = draft.entries[(other += offset)];
  const current = draft.entries[index];

  if (!current || !next) return draft;
  const entries = [...draft.entries];
  entries[index] = next;
  entries[other] = current;

  return { ...draft, entries };
}

export const remove = (draft: Draft, index: number): Draft => ({
  ...draft,
  entries: draft.entries.filter((_, at) => at !== index),
});
