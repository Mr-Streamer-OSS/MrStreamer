// The channel lists the guide and Watch's channel list show: favourites, recently watched, every
// channel, or one category. Categories group under their country, as the provider names them.
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Listing, ListingMatch } from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { normalize, searchWords } from "@mrstreamer/core/text";
import { useUi, type ChannelList } from "../../app/ui-store.ts";
import { useNow } from "../../lib/clock.ts";
import { endOfDay } from "../../lib/format.ts";
import { queries, rememberCategory, useSubscriptions } from "../../lib/queries.ts";

const NO_IDS: readonly OwnedId[] = [];
/** Channels whose listings are asked for together. */
const LISTINGS_PAGE = 40;
const NO_CHANNELS: readonly LiveChannel[] = [];
/** A search waits this long for typing to pause, as the other searches do. */
const SEARCH_DELAY_MS = 120;
const NO_WORDS: readonly string[] = [];
const NO_MATCHES: Readonly<Record<string, ListingMatch>> = {};

/** The channels of a list, in its order; undefined while they load. */
export function useListChannels(list: ChannelList): {
  readonly channels: readonly LiveChannel[] | undefined;
  readonly error: unknown;
} {
  const viewing = useQuery(queries.viewing());
  const ids =
    list.kind === "favourites"
      ? (viewing.data?.favourites ?? NO_IDS)
      : list.kind === "recent"
        ? (viewing.data?.recent ?? NO_IDS)
        : NO_IDS;
  const byIds = useQuery(queries.channelsOf(ids));
  const listed = list.kind === "favourites" || list.kind === "recent";
  const byCategory = useQuery({
    ...queries.channels(list.kind === "category" ? list.category : null),
    enabled: !listed,
  });
  if (!listed) return { channels: byCategory.data, error: byCategory.error };
  if (!viewing.data) return { channels: undefined, error: viewing.error };
  return { channels: ids.length === 0 ? NO_CHANNELS : byIds.data, error: byIds.error };
}

/**
 * Searches a list for `text`, and gives the channels found in the list's order with what marks
 * them: all of them, and no words, without a search. A channel is found when every word shows
 * among its names, the one shown, the provider's and each stream's, or in the title of one of
 * its programmes on now or later today. The names are at hand; the main process finds the
 * programmes in the guide it has loaded, so typing asks the provider nothing, and a list without
 * a guide still finds names.
 *   Rows change once the programmes for what was typed are in, names and programmes together:
 * until then they keep to the search answered before.
 */
export function useListSearch(
  list: ChannelList,
  channels: readonly LiveChannel[],
  text: string,
): {
  readonly channels: readonly LiveChannel[];
  /** The search the channels are for, as typed; empty without one. */
  readonly query: string;
  /** Its words as search compares them, for marking what matched. */
  readonly words: readonly string[];
  /** What it found in each channel's programmes today, by the channel's `ownedKey`. */
  readonly matches: Readonly<Record<string, ListingMatch>>;
} {
  // What was typed, once typing pauses. An emptied field counts at once: the whole list shows
  // without a wait, and what the field held before never searches the list shown next.
  const [settled, settle] = useState(text);
  useEffect(() => {
    if (text.trim() === "") {
      settle("");
      return;
    }
    const timer = setTimeout(() => settle(text), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const query = text.trim() === "" ? "" : settled.trim();
  const until = endOfDay(useNow());
  const scope = useMemo(
    () =>
      list.kind === "category"
        ? { category: ownedId(list.category) }
        : list.kind === "all"
          ? {}
          : { channels: channels.map(ownedId) },
    [list, channels],
  );
  const found = useQuery(queries.listSearch(scope, query, until));
  // The answer the rows are drawn from: the latest, kept while the next search is asked for.
  const [kept, keep] = useState(found.data);
  const answer = query === "" ? undefined : (found.data ?? kept);
  if (answer !== kept) keep(answer);

  return useMemo(() => {
    const words = answer ? searchWords(answer.query) : NO_WORDS;
    if (!answer || words.length === 0) {
      return { channels, query: "", words: NO_WORDS, matches: NO_MATCHES };
    }
    const { query, matches } = answer;
    const names = searchNames(channels);
    return {
      channels: channels.filter(
        (channel, index) =>
          matches[ownedKey(channel)] !== undefined ||
          words.every((word) => names[index]?.includes(word)),
      ),
      query,
      words,
      matches,
    };
  }, [channels, answer]);
}

/** Each list's names as search compares them, worked out at its first search. */
const foldedNames = new WeakMap<readonly LiveChannel[], readonly string[]>();

/**
 * The names of each of a list's channels, folded and in the list's order: the one shown, then
 * each stream's as the provider wrote it.
 */
function searchNames(channels: readonly LiveChannel[]): readonly string[] {
  let names = foldedNames.get(channels);
  if (!names) {
    names = channels.map((channel) =>
      normalize([channel.title, ...channel.variants.map((variant) => variant.name)].join(" ")),
    );
    foldedNames.set(channels, names);
  }
  return names;
}

/** The list's name: "Favourites", or the category's own. */
export function listTitle(list: ChannelList, categories: ReadonlyMap<string, Category>): string {
  switch (list.kind) {
    case "favourites":
      return "Favourites";
    case "recent":
      return "Recently watched";
    case "all":
      return "All channels";
    case "category":
      return categories.get(ownedKey(list.category))?.title ?? "Channels";
  }
}

/**
 * Shows a list in the guide. A category, or all channels, is where Live TV opens next time: a
 * category is kept for its own subscription, and all channels by none of them keeping one.
 */
export function useShowList(): (list: ChannelList) => void {
  const client = useQueryClient();
  const subscriptions = useSubscriptions();
  return useCallback(
    (list) => {
      useUi.setState({ list });
      if (list.kind !== "category" && list.kind !== "all") return;
      const category = list.kind === "category" ? list.category : null;
      void rememberCategory(client, subscriptions, category).catch(() => {});
    },
    [client, subscriptions],
  );
}

export type ListEntry =
  | {
      readonly kind: "list";
      readonly list: ChannelList;
      readonly title: string;
      readonly count: number;
      /** Listed under an open country. */
      readonly nested: boolean;
    }
  | {
      readonly kind: "group";
      readonly group: string;
      readonly count: number;
      readonly open: boolean;
    };

/**
 * What the list picker shows: favourites, recently watched and all channels, then categories in
 * provider order. Grouped ones sit under their country, which lists them all when open.
 */
export function useListEntries(open: ReadonlySet<string>): readonly ListEntry[] {
  const categories = useQuery(queries.categories());
  const viewing = useQuery(queries.viewing());
  const status = useQuery(queries.libraryStatus());
  return useMemo(() => {
    const entries: ListEntry[] = [
      {
        kind: "list",
        list: { kind: "favourites" },
        title: "Favourites",
        count: viewing.data?.favourites.length ?? 0,
        nested: false,
      },
      {
        kind: "list",
        list: { kind: "recent" },
        title: "Recently watched",
        count: viewing.data?.recent.length ?? 0,
        nested: false,
      },
      {
        kind: "list",
        list: { kind: "all" },
        title: "All channels",
        // Every subscription's channels, as the list shows them.
        count: (status.data ?? []).reduce((sum, each) => sum + each.channelCount, 0),
        nested: false,
      },
    ];
    const all = categories.data ?? [];
    const groups = new Map<string, Category[]>();
    for (const category of all) {
      if (category.group === null) continue;
      const members = groups.get(category.group);
      if (members) members.push(category);
      else groups.set(category.group, [category]);
    }
    const categoryEntry = (category: Category, nested: boolean): ListEntry => ({
      kind: "list",
      list: { kind: "category", category: ownedId(category) },
      title: category.title,
      count: category.channelCount,
      nested,
    });
    const placed = new Set<string>();
    for (const category of all) {
      const { group } = category;
      if (group === null) {
        entries.push(categoryEntry(category, false));
        continue;
      }
      if (placed.has(group)) continue;
      placed.add(group);
      const members = groups.get(group) ?? [];
      const expanded = open.has(group);
      const count = members.reduce((sum, member) => sum + member.channelCount, 0);
      entries.push({ kind: "group", group, count, open: expanded });
      if (expanded) entries.push(...members.map((member) => categoryEntry(member, true)));
    }
    return entries;
  }, [categories.data, viewing.data, status.data, open]);
}

/** The country a list's category sits under, so the picker can open it. */
export function groupOf(
  list: ChannelList,
  categories: ReadonlyMap<string, Category>,
): string | null {
  return list.kind === "category" ? (categories.get(ownedKey(list.category))?.group ?? null) : null;
}

/**
 * Now and next for the channels at `visible` positions in a long list, by each channel's
 * `ownedKey`. Asks in pages of 40, so scrolling a list of thousands asks only for what comes into
 * view.
 */
export function useVisibleListings(
  channels: readonly LiveChannel[],
  visible: readonly number[],
): ReadonlyMap<string, Listing> {
  const pages = [...new Set(visible.map((index) => Math.floor(index / LISTINGS_PAGE)))];
  return useQueries({
    queries: pages.map((page) =>
      queries.listings(channels.slice(page * LISTINGS_PAGE, (page + 1) * LISTINGS_PAGE)),
    ),
    combine: (results) => {
      const merged = new Map<string, Listing>();
      for (const result of results) {
        for (const [key, listing] of Object.entries(result.data ?? {})) merged.set(key, listing);
      }
      return merged;
    },
  });
}

/** The channel `delta` steps from `current` in `list`, wrapping around like channel up and down. */
export function adjacentChannel(
  list: readonly LiveChannel[],
  current: OwnedId | null | undefined,
  delta: number,
): LiveChannel | undefined {
  if (list.length === 0) return undefined;
  const index = list.findIndex((channel) => sameOwned(channel, current));
  if (index === -1) return delta > 0 ? list[0] : list[list.length - 1];
  return list[(index + delta + list.length) % list.length];
}
