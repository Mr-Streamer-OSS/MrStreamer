import { AppFailure } from "@mrstreamer/contracts/errors";
import { CUSTOM_LIST_NAME_MAX } from "@mrstreamer/contracts/custom-lists";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { normalize } from "@mrstreamer/core/text";
import { type } from "arktype";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  currentCatalogue,
  members,
  useCatalogue,
  useRoster,
  type Catalogue,
  type Member,
  type Roster,
} from "./account.ts";
import { listedNow, type Unavailable } from "./favourites.ts";
import { readJson, writeJson } from "./files.ts";
import type { Channel } from "./library.ts";
import { readRegistry } from "./subscriptions.ts";

// The viewer's channel lists, apart from Favourites: named, in an order of the viewer's, each
// holding exact channels of any saved subscription in an order of its own, as the desktop keeps
// them (apps/desktop/src/main/services/custom-lists.ts). One JSON file in Documents, written whole
// before any screen shows a change: a write the folder refuses throws and changes nothing.
//
// A channel of a list is kept under its subscription by every stream id it was seen with, and is
// whichever channel Live lists now under the first of them its subscription still lists, so it is
// the same channel after the provider lists it under another id or joins its qualities. After each
// change of the channels shown, what the lists hold is brought in line, so a channel is followed
// from one list to the next. Nothing is ever found by name or in another subscription. A channel
// whose subscription is saved but doesn't list it now, still loads, or needs its password is named
// as it was last listed, plays nothing and can be taken out. One of a subscription removed with its
// history kept is counted and back once it is added again; one removed with its history erased is
// deleted from every list. Both happen while a screen shows the lists (`useChannelLists`), as Live's
// own rows always do.
//
// Lists keep the order they were made in. An edit of a list's channels is made from the list as it
// showed: it lands only while the list's revision and the channels it opened still hold, so nothing
// moves or goes under channels that changed meanwhile.

const FILE = "custom-lists.json";

const Saved = lazy(() =>
  type({
    version: "1",
    lists: type({
      id: "string",
      name: "string",
      revision: "number",
      members: type({
        member: "string",
        subscriptionId: "string",
        /** Every stream id it was seen with, the one it was found by when last listed first. */
        streams: "string[] > 0",
        /** What it was called when last listed. */
        name: "string",
      }).array(),
    }).array(),
  }),
);
type StoredList = Infer<typeof Saved>["lists"][number];
type StoredMember = StoredList["members"][number];

/**
 * The lists as the file holds them. `foreign` is a file this build can't read, as a later build's:
 * no list shows and nothing is written over it.
 */
type Kept =
  { readonly kind: "read"; readonly lists: readonly StoredList[] } | { readonly kind: "foreign" };

function readKept(): Kept {
  const read = readJson(FILE);
  if (read === null) return { kind: "read", lists: [] };
  const parsed = Saved()(read);
  return parsed instanceof type.errors
    ? { kind: "foreign" }
    : { kind: "read", lists: parsed.lists };
}

/** The file, read once, at the first look, then kept as written. */
let cached: Kept | null = null;
const keptNow = () => (cached ??= readKept());
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
function keep(next: Kept) {
  cached = next;
  for (const listener of listeners) listener();
}

/** A channel of a list as it shows now. */
export type ListEntry =
  | { readonly kind: "listed"; readonly member: string; readonly channel: Channel }
  /** Its subscription is saved and doesn't open it now: by its last name, and why. */
  | {
      readonly kind: "unavailable";
      readonly member: string;
      readonly name: string;
      readonly label: string;
      readonly why: Unavailable;
    };

export interface ChannelList {
  readonly id: string;
  readonly name: string;
  /** Rises with every change to its channels or their order: an order made from another is refused. */
  readonly revision: number;
  /** In the list's order, each channel once. */
  readonly entries: readonly ListEntry[];
  /** Channels kept for subscriptions removed with their history kept, back once added again. */
  readonly away: number;
}

/** Every stream id of a channel, its own first. */
const streamsOf = (channel: Channel) => [
  ...new Set([channel.id, ...channel.variants.map((variant) => variant.id)]),
];

/** The channel a stored one is now, by the first of its streams its subscription lists, and that stream. */
function resolve(library: Catalogue, stored: StoredMember) {
  if (library.kind !== "ready") return null;
  for (const via of stored.streams) {
    const channel = library.library.byKey.get(
      ownedKey({ subscriptionId: stored.subscriptionId, id: via }),
    );
    if (channel) return { channel, via };
  }
  return null;
}

/** `list` as it shows with the channels of `catalogue` and the saved subscriptions `saved`. */
function shownOf(list: StoredList, catalogue: Catalogue, saved: readonly Member[]): ChannelList {
  const byId = new Map(saved.map((member) => [member.entry.id, member]));
  const shown = catalogue.kind === "ready" ? catalogue.library.labels : new Map<string, string>();
  const entries: ListEntry[] = [];
  const seen = new Set<string>();
  let away = 0;
  for (const stored of list.members) {
    const owner = byId.get(stored.subscriptionId);
    if (!owner) {
      away++;
      continue;
    }
    const found = owner.needsSecret ? null : resolve(catalogue, stored);
    if (found) {
      // Two of its channels the provider joined since show as one.
      if (seen.has(found.channel.key)) continue;
      seen.add(found.channel.key);
      entries.push({ kind: "listed", member: stored.member, channel: found.channel });
      continue;
    }
    const why: Unavailable = owner.needsSecret
      ? "needs-secret"
      : shown.has(stored.subscriptionId)
        ? "not-listed"
        : owner.live.kind === "failed"
          ? "failed"
          : "loading";
    entries.push({
      kind: "unavailable",
      member: stored.member,
      name: stored.name,
      label: owner.label,
      why,
    });
  }
  return { id: list.id, name: list.name, revision: list.revision, entries, away };
}

const listsOf = (from: Kept, catalogue: Catalogue, saved: readonly Member[]) =>
  from.kind === "read" ? from.lists.map((list) => shownOf(list, catalogue, saved)) : [];

/** Every list in the viewer's order, drawn again as the lists, the channels or a provider change. */
export function useChannelLists(): readonly ChannelList[] {
  const from = useSyncExternalStore(subscribe, keptNow);
  const catalogue = useCatalogue();
  const roster = useRoster();
  useEffect(() => align(catalogue, roster), [from, catalogue, roster]);
  return useMemo(
    () => listsOf(from, catalogue, roster.kind === "ready" ? roster.members : []),
    [from, catalogue, roster],
  );
}

/** Every list as it shows now, for handlers outside React. */
export const currentChannelLists = (): readonly ChannelList[] =>
  listsOf(keptNow(), currentCatalogue(), members());

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** The lists as the file holds them, or a failure when it holds lists this build can't read. */
function stored(): readonly StoredList[] {
  const from = keptNow();
  if (from.kind === "foreign") {
    throw new AppFailure({
      kind: "invalid-input",
      detail: "These lists were saved by a newer version of the app. Nothing was changed.",
    });
  }
  return from.lists;
}

/** Writes `lists` whole; only once the file took them do the screens show them. */
function save(lists: readonly StoredList[]) {
  writeJson(FILE, { version: 1, lists });
  keep({ kind: "read", lists });
}

/** `lists` with list `id` changed by `change`; `no-list` when there is none. */
function withList(
  lists: readonly StoredList[],
  id: string,
  change: (list: StoredList) => StoredList,
): StoredList[] {
  if (!lists.some((list) => list.id === id)) throw new AppFailure({ kind: "no-list" });
  return lists.map((list) => (list.id === id ? change(list) : list));
}

/** `name` trimmed, once it is 1 to 60 characters and no other list is called it, apart from case and accents. */
function nameOf(lists: readonly StoredList[], name: string, except?: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > CUSTOM_LIST_NAME_MAX) {
    throw new AppFailure({
      kind: "invalid-input",
      detail: `A list's name has 1 to ${CUSTOM_LIST_NAME_MAX} characters.`,
    });
  }
  const folded = normalize(trimmed);
  if (lists.some((list) => list.id !== except && normalize(list.name) === folded)) {
    throw new AppFailure({ kind: "list-name-taken" });
  }
  return trimmed;
}

/**
 * The one channel Live lists now for `channel`, as a change names it: `no-subscription` once its
 * subscription went, `channel-not-found` when it lists none of its streams, `list-changed` when they
 * are in more than one channel now.
 */
function listedChannel(channel: Channel): Channel {
  const now = listedNow(channel, currentCatalogue(), members());
  if (now.kind === "listed") return now.channel;
  throw new AppFailure(
    now.kind === "removed"
      ? { kind: "no-subscription" }
      : now.kind === "split"
        ? { kind: "list-changed" }
        : { kind: "channel-not-found", channelId: channel.id },
  );
}

/** Makes a list called `name` after the others, holding `first` when given. Answers its id. */
export function createList(name: string, first?: Channel): string {
  const lists = stored();
  const named = nameOf(lists, name);
  const channel = first ? listedChannel(first) : null;
  const id = newId();
  const members = channel ? [memberOf(channel)] : [];
  save([...lists, { id, name: named, revision: 0, members }]);
  return id;
}

/** Calls list `id` `name`, trimmed. */
export function renameList(id: string, name: string): void {
  const lists = stored();
  const named = nameOf(lists, name, id);
  save(withList(lists, id, (list) => ({ ...list, name: named })));
}

/** Deletes list `id` and every channel it holds. Deleting one already gone changes nothing. */
export function deleteList(id: string): void {
  const lists = stored();
  if (!lists.some((list) => list.id === id)) return;
  save(lists.filter((list) => list.id !== id));
}

const memberOf = (channel: Channel): StoredMember => ({
  member: newId(),
  subscriptionId: channel.subscriptionId,
  streams: streamsOf(channel),
  name: channel.title,
});

/**
 * Puts `channel`, as Live lists it now, at the end of list `id`, or takes it out. Adding one there
 * already, or taking out one that isn't, changes nothing. Fails as `listedChannel` says when that is
 * no one channel any more, and with `no-list`.
 */
export function setMember(id: string, channel: Channel, member: boolean): void {
  const lists = stored();
  const now = listedChannel(channel);
  const catalogue = currentCatalogue();
  const same = (stored: StoredMember) =>
    stored.subscriptionId === now.subscriptionId &&
    resolve(catalogue, stored)?.channel.key === now.key;
  const list = lists.find((each) => each.id === id);
  if (!list) throw new AppFailure({ kind: "no-list" });
  const holds = list.members.some(same);
  if (holds === member) return;
  save(
    withList(lists, id, (list) => ({
      ...list,
      revision: list.revision + 1,
      members: member
        ? [...list.members, memberOf(now)]
        : list.members.filter((each) => !same(each)),
    })),
  );
}

/** Takes a channel out of list `id` by its member id, as for one that doesn't open now. */
export function removeMember(id: string, member: string): void {
  const lists = stored();
  const list = lists.find((each) => each.id === id);
  if (!list) throw new AppFailure({ kind: "no-list" });
  if (!list.members.some((each) => each.member === member)) return;
  save(
    withList(lists, id, (list) => ({
      ...list,
      revision: list.revision + 1,
      members: list.members.filter((each) => each.member !== member),
    })),
  );
}

/**
 * Saves an edit of the list `from` shows: takes out the channels `removed` names, by member id, and
 * puts those `order` names in that order, in the places they had among its channels; the rest keep
 * theirs. Refuses with `list-changed`, changing nothing, once its revision or the channels it opens
 * are others than `from`'s, `removed` names one it didn't show, or `order` isn't the rest of those
 * it opened.
 */
export function arrangeList(
  from: ChannelList,
  order: readonly string[],
  removed: readonly string[] = [],
): void {
  const lists = stored();
  const list = lists.find((each) => each.id === from.id);
  if (!list) throw new AppFailure({ kind: "no-list" });
  const opened = (shown: ChannelList) =>
    shown.entries.flatMap((entry) =>
      entry.kind === "listed" ? [`${entry.member} ${entry.channel.key}`] : [],
    );
  const now = shownOf(list, currentCatalogue(), members());
  const out = new Set(removed);
  const kept = now.entries.flatMap((entry) =>
    entry.kind === "listed" && !out.has(entry.member) ? [entry.member] : [],
  );
  const sorted = (ids: Iterable<string>) => [...ids].sort().join("\n");
  if (
    list.revision !== from.revision ||
    opened(now).join("\n") !== opened(from).join("\n") ||
    !removed.every((member) => from.entries.some((entry) => entry.member === member)) ||
    sorted(order) !== sorted(kept)
  ) {
    throw new AppFailure({ kind: "list-changed" });
  }
  const moved = new Set(order);
  const byMember = new Map(list.members.map((each) => [each.member, each]));
  const next = order.values();
  const arranged = list.members.flatMap((each) =>
    out.has(each.member) ? [] : [moved.has(each.member) ? byMember.get(next.next().value!)! : each],
  );
  save(
    withList(lists, from.id, (list) => ({
      ...list,
      revision: list.revision + 1,
      members: arranged,
    })),
  );
}

/**
 * Brings what the lists hold in line with the channels shown now: each channel found takes the
 * streams and name it has now, the stream it was found by first. Deletes the channels of
 * subscriptions removed with their history erased. A write the folder refuses is tried again at
 * the next change.
 */
function align(catalogue: Catalogue, roster: Roster) {
  const from = keptNow();
  if (from.kind !== "read" || roster.kind !== "ready") return;
  const saved = new Set(roster.members.map((member) => member.entry.id));
  let retired: ReadonlySet<string> | null = null;
  const kept = (id: string) =>
    (retired ??= new Set(readRegistry()?.registry.retired.map((each) => each.id) ?? [])).has(id);
  let changed = false;
  const lists = from.lists.map((list) => {
    const members = list.members.flatMap((stored): StoredMember[] => {
      if (!saved.has(stored.subscriptionId)) {
        if (kept(stored.subscriptionId)) return [stored];
        changed = true;
        return [];
      }
      const found = resolve(catalogue, stored);
      if (!found) return [stored];
      const streams = [...new Set([found.via, ...streamsOf(found.channel), ...stored.streams])];
      if (streams.join("\n") === stored.streams.join("\n") && found.channel.title === stored.name) {
        return [stored];
      }
      changed = true;
      return [{ ...stored, streams, name: found.channel.title }];
    });
    return members.length === list.members.length &&
      members.every((each, at) => each === list.members[at])
      ? list
      : { ...list, members };
  });
  if (!changed) return;
  try {
    save(lists);
  } catch {
    // Kept as they were until the next change of the channels or the providers.
  }
}
