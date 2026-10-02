// React Query bindings for the IPC contract. Components read data through these hooks only.
import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import type {
  CollectionId,
  CollectionSort,
  RowTab,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { call, listen } from "./ipc.ts";

/** Listings move on as programmes end; asking again each minute is enough for progress. */
const LISTINGS_REFRESH_MS = 60_000;

export const queries = {
  subscription: () =>
    queryOptions({ queryKey: ["subscription"], queryFn: () => call("subscription.get") }),
  preferences: () =>
    queryOptions({
      queryKey: ["preferences"],
      queryFn: () => call("preferences.get"),
      staleTime: Infinity,
    }),
  /** Favourites and recently watched channels. Kept current by `syncViewing`. */
  viewing: () =>
    queryOptions({
      queryKey: ["viewing"],
      queryFn: () => call("viewing.get"),
      staleTime: Infinity,
    }),
  /** How many channels the guide covers, and since when. Read again on `guide.updated`. */
  guideStatus: () =>
    queryOptions({ queryKey: ["guide", "status"], queryFn: () => call("guide.status") }),
  libraryStatus: () =>
    queryOptions({ queryKey: ["library", "status"], queryFn: () => call("library.status") }),
  categories: () =>
    queryOptions({
      queryKey: ["library", "categories"],
      queryFn: () => call("library.categories"),
      staleTime: Infinity,
    }),
  /** All channels when `categoryId` is null. */
  channels: (categoryId: string | null) =>
    queryOptions({
      queryKey: ["library", "channels", categoryId],
      queryFn: () => call("library.channels", categoryId === null ? {} : { categoryId }),
      staleTime: Infinity,
    }),
  channel: (channelId: string) =>
    queryOptions({
      queryKey: ["library", "channel", channelId],
      queryFn: () => call("library.channel", { channelId }),
      staleTime: Infinity,
    }),
  /** Channels by id, in the order given. */
  channelsById: (ids: readonly string[]) =>
    queryOptions({
      queryKey: ["library", "ids", ...ids],
      queryFn: () => call("library.channels", { ids: [...ids] }),
      staleTime: Infinity,
      enabled: ids.length > 0,
    }),
  /** Kept current by `syncUpdates`, so it never needs refetching. */
  updates: () =>
    queryOptions({
      queryKey: ["updates"],
      queryFn: () => call("updates.status"),
      staleTime: Infinity,
    }),
  search: (query: string) =>
    queryOptions({
      queryKey: ["library", "search", query],
      queryFn: () => call("library.channels", { query }),
      staleTime: Infinity,
      enabled: query.trim().length > 0,
    }),
  /** Now and next for the given channels. Channels without guide data are missing. */
  listings: (channelIds: readonly string[]) =>
    queryOptions({
      queryKey: ["guide", "listings", ...channelIds],
      queryFn: () => call("guide.listings", { channelIds: [...channelIds] }),
      enabled: channelIds.length > 0,
      staleTime: LISTINGS_REFRESH_MS / 2,
      refetchInterval: LISTINGS_REFRESH_MS,
      placeholderData: (previous) => previous,
    }),
  schedule: (channelId: string) =>
    queryOptions({
      queryKey: ["guide", "schedule", channelId],
      queryFn: () => call("guide.schedule", { channelId }),
      staleTime: LISTINGS_REFRESH_MS,
    }),
  programmes: (query: string) =>
    queryOptions({
      queryKey: ["guide", "search", query],
      queryFn: () => call("guide.search", { query }),
      staleTime: LISTINGS_REFRESH_MS,
      enabled: query.trim().length > 0,
    }),
  /** How many movies and series there are, and when they were fetched. */
  onDemandStatus: () =>
    queryOptions({
      queryKey: ["ondemand", "status"],
      queryFn: () => call("ondemand.status"),
      staleTime: Infinity,
    }),
  /** A tab's rows; For you starts with titles like `like`, one watched lately. */
  rows: (kind: TitleKind, tab: RowTab, like: string | null) =>
    queryOptions({
      queryKey: ["ondemand", "rows", kind, tab, like],
      queryFn: () => call("ondemand.rows", { kind, tab, ...(like ? { like } : {}) }),
      staleTime: Infinity,
      placeholderData: (previous) => previous,
    }),
  /** Genres or streaming services as tiles. */
  tiles: (kind: TitleKind, of: "genres" | "services") =>
    queryOptions({
      queryKey: ["ondemand", "tiles", kind, of],
      queryFn: () => call("ondemand.tiles", { kind, of }),
      staleTime: Infinity,
      placeholderData: (previous) => previous,
    }),
  /** One page of a collection, in `sort` or the collection's own order. */
  collection: (
    kind: TitleKind,
    id: CollectionId,
    sort: CollectionSort | undefined,
    offset: number,
    limit: number,
  ) =>
    queryOptions({
      queryKey: ["ondemand", "collection", kind, id, sort ?? null, offset, limit],
      queryFn: () =>
        call("ondemand.collection", { kind, id, offset, limit, ...(sort ? { sort } : {}) }),
      staleTime: Infinity,
      placeholderData: (previous) => previous,
    }),
  titleSearch: (query: string) =>
    queryOptions({
      queryKey: ["ondemand", "search", query],
      queryFn: () => call("ondemand.search", { query }),
      staleTime: Infinity,
      enabled: query.trim().length > 0,
    }),
  /** Movies or series only, for the field in their tab bar. */
  titleSearchIn: (kind: TitleKind, query: string) =>
    queryOptions({
      queryKey: ["ondemand", "searchKind", kind, query],
      queryFn: () => call("ondemand.searchKind", { kind, query }),
      staleTime: Infinity,
      enabled: query.trim().length > 0,
    }),
  /** Titles from the lists, by the id of any version; asks the provider nothing. */
  titles: (kind: TitleKind, ids: readonly string[]) =>
    queryOptions({
      queryKey: ["ondemand", "titles", kind, ids],
      queryFn: () => call("ondemand.titles", { kind, ids: [...ids] }),
      enabled: ids.length > 0,
    }),
  details: (kind: TitleKind, id: string) =>
    queryOptions({
      queryKey: ["ondemand", "details", kind, id],
      queryFn: () => call("ondemand.details", { kind, id }),
      staleTime: 30 * 60_000,
    }),
  /**
   * The episodes of a series version's season with TMDB's details, for when it shows. Read again
   * each time it shows: the main process keeps what TMDB said, and asks again what it didn't.
   */
  season: (id: string, season: number) =>
    queryOptions({
      queryKey: ["ondemand", "season", id, season],
      queryFn: () => call("ondemand.season", { id, season }),
    }),
  /**
   * How far movies, or every episode of series, got: each id a language version of one title.
   * Kept current by `syncViewing`.
   */
  progress: (filter: {
    readonly movieIds?: readonly string[];
    readonly seriesIds?: readonly string[];
  }) =>
    queryOptions({
      queryKey: ["viewing", "progress", filter.movieIds ?? [], filter.seriesIds ?? []],
      queryFn: () =>
        call("viewing.progress", {
          ...(filter.movieIds ? { movieIds: [...filter.movieIds] } : {}),
          ...(filter.seriesIds ? { seriesIds: [...filter.seriesIds] } : {}),
        }),
      staleTime: Infinity,
    }),
  licences: () =>
    queryOptions({
      queryKey: ["licences"],
      queryFn: () => call("licences.list"),
      staleTime: Infinity,
    }),
  licenceText: (id: string) =>
    queryOptions({
      queryKey: ["licences", id],
      queryFn: () => call("licences.text", { id }),
      staleTime: Infinity,
    }),
};

/** Stars or unstars a channel. The favourites list updates as soon as the main process has it. */
export function useToggleFavourite(): (channelId: string) => void {
  const client = useQueryClient();
  return useCallback(
    (channelId: string) => {
      const favourites = client.getQueryData(queries.viewing().queryKey)?.favourites ?? [];
      void call("viewing.setFavourite", {
        commandId: crypto.randomUUID(),
        channelId,
        favourite: !favourites.includes(channelId),
      }).then(
        (viewing) => keepViewing(client, viewing),
        () => {},
      );
    },
    [client],
  );
}

/** Keeps the latest viewing state: an answer can arrive after a later change's event. */
function keepViewing(client: QueryClient, viewing: Viewing): void {
  client.setQueryData(queries.viewing().queryKey, (cached) =>
    cached && cached.sequence > viewing.sequence ? cached : viewing,
  );
}

/** The last watched channel, or null before the first or once the catalogue no longer has it. */
export function useLastChannel(): LiveChannel | null {
  const { data: preferences } = useQuery(queries.preferences());
  const channelId = preferences?.lastChannelId ?? null;
  const { data } = useQuery({ ...queries.channel(channelId ?? ""), enabled: channelId !== null });
  return (channelId !== null && data) || null;
}

/** The ids of the favourite channels, in the order they were added. */
export function useFavouriteIds(): ReadonlySet<string> {
  const { data } = useQuery(queries.viewing());
  return useMemo(() => new Set(data?.favourites), [data]);
}

function useCategories() {
  return useQuery(queries.categories());
}

/** Categories by id, for labelling channels. */
export function useCategoryMap(): ReadonlyMap<string, Category> {
  const { data } = useCategories();
  return useMemo(() => new Map(data?.map((category) => [category.id, category])), [data]);
}

/** Refetches library data whenever the main process reports a new catalogue. */
export function syncLibraryUpdates(client: QueryClient): () => void {
  return listen("library.updated", () => {
    void client.invalidateQueries({ queryKey: ["library"] });
  });
}

/** Reads movies and series again once the main process has fetched new lists. */
export function syncOnDemand(client: QueryClient): () => void {
  return listen("ondemand.updated", () => {
    // Lists change with a refresh and as TMDB's metadata arrives. A season shown is read again
    // the next time it shows, not each time more metadata arrives.
    void client.invalidateQueries({
      queryKey: ["ondemand"],
      predicate: (query) => query.queryKey[1] !== "details" && query.queryKey[1] !== "season",
    });
    // So do the names and languages details show. Open details keep what they show; opened
    // again, they are put together anew from what the main process kept, with nothing downloaded.
    void client.invalidateQueries({ queryKey: ["ondemand", "details"], refetchType: "none" });
  });
}

/** Asks for programmes again once the main process has a new guide. */
export function syncGuideUpdates(client: QueryClient): () => void {
  return listen("guide.updated", () => {
    void client.invalidateQueries({ queryKey: ["guide"] });
  });
}

/**
 * Reads favourites, recently watched channels and progress again once the main process has a
 * later change.
 */
export function syncViewing(client: QueryClient): () => void {
  return listen("viewing.changed", ({ sequence }) => {
    const cached = client.getQueryData(queries.viewing().queryKey);
    if (cached && cached.sequence >= sequence) return;
    // The prefix covers the progress queries too.
    void client.invalidateQueries({ queryKey: queries.viewing().queryKey });
  });
}

/** Keeps the update status current: download progress and outcomes arrive as events. */
export function syncUpdates(client: QueryClient): () => void {
  return listen("updates.changed", (status) => {
    client.setQueryData(queries.updates().queryKey, status);
  });
}
