// The channel lists the guide and Watch's channel list show: favourites, recently watched, every
// channel, or one category. Categories group under their country, as the provider names them.
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Listing } from "../../../../shared/guide.ts";
import type { Category, LiveChannel } from "../../../../shared/library.ts";
import { useUi, type ChannelList } from "../../app/ui-store.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";

const NO_IDS: readonly string[] = [];
/** Channels whose listings are asked for together. */
const LISTINGS_PAGE = 40;
const NO_CHANNELS: readonly LiveChannel[] = [];

/** The channels of a list, in its order; undefined while they load. */
export function useListChannels(list: ChannelList): {
  readonly channels: readonly LiveChannel[] | undefined;
  readonly error: unknown;
} {
  const preferences = useQuery(queries.preferences());
  const ids =
    list.kind === "favourites"
      ? (preferences.data?.favouriteChannelIds ?? NO_IDS)
      : list.kind === "recent"
        ? (preferences.data?.recentChannelIds ?? NO_IDS)
        : NO_IDS;
  const byIds = useQuery(queries.channelsById(ids));
  const listed = list.kind === "favourites" || list.kind === "recent";
  const byCategory = useQuery({
    ...queries.channels(list.kind === "category" ? list.id : null),
    enabled: !listed,
  });
  if (!listed) return { channels: byCategory.data, error: byCategory.error };
  if (!preferences.data) return { channels: undefined, error: preferences.error };
  return { channels: ids.length === 0 ? NO_CHANNELS : byIds.data, error: byIds.error };
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
      return categories.get(list.id)?.title ?? "Channels";
  }
}

/** Shows a list in the guide. A category, or all channels, is where Live TV opens next time. */
export function showList(list: ChannelList): void {
  useUi.setState({ list });
  if (list.kind === "category" || list.kind === "all") {
    const lastCategoryId = list.kind === "category" ? list.id : null;
    void call("preferences.update", { lastCategoryId }).catch(() => {});
  }
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
  const preferences = useQuery(queries.preferences());
  const status = useQuery(queries.libraryStatus());
  return useMemo(() => {
    const entries: ListEntry[] = [
      {
        kind: "list",
        list: { kind: "favourites" },
        title: "Favourites",
        count: preferences.data?.favouriteChannelIds.length ?? 0,
        nested: false,
      },
      {
        kind: "list",
        list: { kind: "recent" },
        title: "Recently watched",
        count: preferences.data?.recentChannelIds.length ?? 0,
        nested: false,
      },
      {
        kind: "list",
        list: { kind: "all" },
        title: "All channels",
        count: status.data?.channelCount ?? 0,
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
      list: { kind: "category", id: category.id },
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
  }, [categories.data, preferences.data, status.data, open]);
}

/** The country a list's category sits under, so the picker can open it. */
export function groupOf(
  list: ChannelList,
  categories: ReadonlyMap<string, Category>,
): string | null {
  return list.kind === "category" ? (categories.get(list.id)?.group ?? null) : null;
}

/**
 * Now and next for the channels at `visible` positions in a long list. Asks in pages of 40, so
 * scrolling a list of thousands asks only for what comes into view.
 */
export function useVisibleListings(
  channels: readonly LiveChannel[],
  visible: readonly number[],
): ReadonlyMap<string, Listing> {
  const pages = [...new Set(visible.map((index) => Math.floor(index / LISTINGS_PAGE)))];
  return useQueries({
    queries: pages.map((page) =>
      queries.listings(
        channels
          .slice(page * LISTINGS_PAGE, (page + 1) * LISTINGS_PAGE)
          .map((channel) => channel.id),
      ),
    ),
    combine: (results) => {
      const merged = new Map<string, Listing>();
      for (const result of results) {
        for (const [id, listing] of Object.entries(result.data ?? {})) merged.set(id, listing);
      }
      return merged;
    },
  });
}

/** The channel `delta` steps from `currentId` in `list`, wrapping around like channel up and down. */
export function adjacentChannel(
  list: readonly LiveChannel[],
  currentId: string | null | undefined,
  delta: number,
): LiveChannel | undefined {
  if (list.length === 0) return undefined;
  const index = list.findIndex((channel) => channel.id === currentId);
  if (index === -1) return delta > 0 ? list[0] : list[list.length - 1];
  return list[(index + delta + list.length) % list.length];
}
