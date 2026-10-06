// React Query bindings for the IPC contract. Components read data through these hooks only.
// Whatever a provider lists is asked for with the subscription it belongs to, and cached under
// both: a provider's ids mean nothing without their subscription.
import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { IpcInput, IpcOutput } from "@mrstreamer/contracts/ipc";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import type {
  CollectionId,
  CollectionSort,
  RowTab,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import type { SubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { TitleFilter, Viewing } from "@mrstreamer/contracts/viewing";
import { player } from "../player/player.ts";
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
  /**
   * What the viewer left a subscription at: the last channel and category, and the versions and
   * streams picked in it.
   */
  subscriptionPreferences: (subscriptionId: string) =>
    queryOptions({
      queryKey: ["subscription-preferences", subscriptionId],
      queryFn: () => call("subscription.preferences", { subscriptionId }),
      staleTime: Infinity,
    }),
  /** Favourites and recently watched channels. Kept current by `syncViewing`. */
  viewing: () =>
    queryOptions({
      queryKey: ["viewing"],
      queryFn: () => call("viewing.get"),
      staleTime: Infinity,
    }),
  /**
   * How many channels the guide covers and since when, or that the subscription has none. Read
   * again on `guide.updated`.
   */
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
  /** All channels when `category` is null. */
  channels: (category: OwnedId | null) =>
    queryOptions({
      queryKey: ["library", "channels", category && ownedKey(category)],
      queryFn: () =>
        call("library.channels", category === null ? {} : { category: ownedId(category) }),
      staleTime: Infinity,
    }),
  channel: (channel: OwnedId) =>
    queryOptions({
      queryKey: ["library", "channel", ownedKey(channel)],
      queryFn: () => call("library.channel", { channel: ownedId(channel) }),
      staleTime: Infinity,
    }),
  /** The given channels, in the order given. */
  channelsOf: (channels: readonly OwnedId[]) =>
    queryOptions({
      queryKey: ["library", "of", ...channels.map(ownedKey)],
      queryFn: () => call("library.channels", { channels: channels.map(ownedId) }),
      staleTime: Infinity,
      enabled: channels.length > 0,
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
  /**
   * Now and next for the given channels, by each channel's `ownedKey`. Channels without guide
   * data are missing.
   */
  listings: (channels: readonly OwnedId[]) =>
    queryOptions({
      queryKey: ["guide", "listings", ...channels.map(ownedKey)],
      queryFn: () => call("guide.listings", { channels: channels.map(ownedId) }),
      enabled: channels.length > 0,
      staleTime: LISTINGS_REFRESH_MS / 2,
      refetchInterval: LISTINGS_REFRESH_MS,
      placeholderData: (previous) => previous,
    }),
  schedule: (channel: OwnedId) =>
    queryOptions({
      queryKey: ["guide", "schedule", ownedKey(channel)],
      queryFn: () => call("guide.schedule", { channel: ownedId(channel) }),
      staleTime: LISTINGS_REFRESH_MS,
    }),
  programmes: (query: string) =>
    queryOptions({
      queryKey: ["guide", "search", query],
      queryFn: () => call("guide.search", { query }),
      staleTime: LISTINGS_REFRESH_MS,
      enabled: query.trim().length > 0,
    }),
  /**
   * What a search finds in the programmes of one list's channels, on now and later until
   * `until`: a category's, the given ones, or every channel, by each channel's `ownedKey`. The
   * answer names the search it is for, so rows can keep to one answer while the next is asked for.
   */
  listSearch: (
    list: Omit<IpcInput<"guide.searchList">, "query" | "until">,
    query: string,
    until: number,
  ) =>
    queryOptions({
      queryKey: ["guide", "searchList", list, query, until],
      queryFn: async () => ({
        query,
        // A search the main process can't answer still finds channels by name.
        matches: await call("guide.searchList", { ...list, query, until }).catch(
          (): IpcOutput<"guide.searchList"> => ({}),
        ),
      }),
      enabled: query !== "",
      staleTime: LISTINGS_REFRESH_MS / 2,
      refetchInterval: LISTINGS_REFRESH_MS,
    }),
  /** How many movies and series there are, and when they were fetched. */
  onDemandStatus: () =>
    queryOptions({
      queryKey: ["ondemand", "status"],
      queryFn: () => call("ondemand.status"),
      staleTime: Infinity,
    }),
  /** A tab's rows; For you starts with titles like `like`, a version of one watched lately. */
  rows: (kind: TitleKind, tab: RowTab, like: OwnedId | null) =>
    queryOptions({
      queryKey: ["ondemand", "rows", kind, tab, like && ownedKey(like)],
      queryFn: () => call("ondemand.rows", { kind, tab, ...(like ? { like: ownedId(like) } : {}) }),
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
  /** Titles from the lists, by any of their versions; asks the provider nothing. */
  titles: (kind: TitleKind, versions: readonly OwnedId[]) =>
    queryOptions({
      queryKey: ["ondemand", "titles", kind, versions.map(ownedKey)],
      queryFn: () => call("ondemand.titles", { kind, versions: versions.map(ownedId) }),
      enabled: versions.length > 0,
    }),
  /** The details of one version of a movie or series. */
  details: (kind: TitleKind, version: OwnedId) =>
    queryOptions({
      queryKey: ["ondemand", "details", kind, ownedKey(version)],
      queryFn: () => call("ondemand.details", { kind, version: ownedId(version) }),
      staleTime: 30 * 60_000,
    }),
  /**
   * The episodes of a series version's season with TMDB's details, for when it shows. Read again
   * each time it shows: the main process keeps what TMDB said, and asks again what it didn't.
   */
  season: (series: OwnedId, season: number) =>
    queryOptions({
      queryKey: ["ondemand", "season", ownedKey(series), season],
      queryFn: () => call("ondemand.season", { series: ownedId(series), season }),
    }),
  /**
   * How far movies, or every episode of series, got: each a language version of one title. Kept
   * current by `syncViewing`.
   */
  progress: (titles: TitleFilter) =>
    queryOptions({
      queryKey: [
        "viewing",
        "progress",
        (titles.movies ?? []).map(ownedKey),
        (titles.series ?? []).map(ownedKey),
      ],
      queryFn: () =>
        call("viewing.progress", {
          ...(titles.movies ? { movies: titles.movies.map(ownedId) } : {}),
          ...(titles.series ? { series: titles.series.map(ownedId) } : {}),
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
export function useToggleFavourite(): (channel: OwnedId) => void {
  const client = useQueryClient();
  return useCallback(
    (channel: OwnedId) => {
      const favourites = client.getQueryData(queries.viewing().queryKey)?.favourites ?? [];
      void call("viewing.setFavourite", {
        commandId: crypto.randomUUID(),
        channel: ownedId(channel),
        favourite: !favourites.some((each) => sameOwned(each, channel)),
      }).then(
        (viewing) => keepViewing(client, viewing),
        () => {},
      );
    },
    [client],
  );
}

/**
 * Changes what the viewer left a subscription at, and keeps the answer for every view that reads
 * it.
 */
export async function updateSubscriptionPreferences(
  client: QueryClient,
  subscriptionId: string,
  patch: Partial<SubscriptionPreferences>,
): Promise<void> {
  const saved = await call("subscription.updatePreferences", { subscriptionId, patch });
  client.setQueryData(queries.subscriptionPreferences(subscriptionId).queryKey, saved);
}

/**
 * Remembers which of a channel's streams plays, or Automatic with null, among its subscription's
 * picks, and opens the channel again with it once saved.
 */
export function useChooseQuality(): (channel: LiveChannel, variantId: string | null) => void {
  const client = useQueryClient();
  return useCallback(
    (channel: LiveChannel, variantId: string | null) => {
      void (async () => {
        const { subscriptionId } = channel;
        const left = await client.fetchQuery(queries.subscriptionPreferences(subscriptionId));
        // A choice kept under another of the channel's streams' ids goes too.
        const others = Object.entries(left.channelVariants ?? {}).filter(
          ([id]) => !channel.variants.some((variant) => variant.id === id),
        );
        const channelVariants = Object.fromEntries(
          variantId === null ? others : [...others, [channel.id, variantId]],
        );
        await updateSubscriptionPreferences(client, subscriptionId, { channelVariants });
        if (sameOwned(player.current(), channel)) player.reopen();
      })().catch(() => {});
    },
    [client],
  );
}

/** Keeps the latest viewing state: an answer can arrive after a later change's event. */
export function keepViewing(client: QueryClient, viewing: Viewing): void {
  client.setQueryData(queries.viewing().queryKey, (cached) =>
    cached && cached.sequence > viewing.sequence ? cached : viewing,
  );
}

/**
 * What the viewer left the saved subscription at, with that subscription's id; undefined until
 * both are known, and without a subscription. `refetchOnMount` reads it afresh as a view opens:
 * the main process notes the channel watched last without going through this cache.
 */
export function useSubscriptionPreferences(
  refetchOnMount?: "always",
): (SubscriptionPreferences & { readonly subscriptionId: string }) | undefined {
  const subscriptionId = useQuery(queries.subscription()).data?.id;
  const { data } = useQuery({
    ...queries.subscriptionPreferences(subscriptionId ?? ""),
    enabled: subscriptionId !== undefined,
    ...(refetchOnMount ? { refetchOnMount } : {}),
  });
  return useMemo(
    () => (subscriptionId !== undefined && data ? { ...data, subscriptionId } : undefined),
    [subscriptionId, data],
  );
}

/** The last watched channel, or null before the first or once the catalogue no longer has it. */
export function useLastChannel(): LiveChannel | null {
  const left = useSubscriptionPreferences();
  const last = useMemo(
    () =>
      left && left.lastChannelId !== null
        ? { subscriptionId: left.subscriptionId, id: left.lastChannelId }
        : null,
    [left],
  );
  const { data } = useQuery({
    ...queries.channel(last ?? { subscriptionId: "", id: "" }),
    enabled: last !== null,
  });
  return (last !== null && data) || null;
}

/** The favourite channels, by `ownedKey`, in their saved order. */
export function useFavouriteKeys(): ReadonlySet<string> {
  const { data } = useQuery(queries.viewing());
  return useMemo(() => new Set(data?.favourites.map(ownedKey)), [data]);
}

function useCategories() {
  return useQuery(queries.categories());
}

/** Categories by `ownedKey`, for labelling channels. */
export function useCategoryMap(): ReadonlyMap<string, Category> {
  const { data } = useCategories();
  return useMemo(() => new Map(data?.map((category) => [ownedKey(category), category])), [data]);
}

/** Refetches library data whenever the main process reports a new catalogue. */
export function syncLibraryUpdates(client: QueryClient): () => void {
  return listen("library.updated", () => {
    void client.invalidateQueries({ queryKey: ["library"] });
    // Favourites and history show by channel, and a new catalogue can join a channel's streams.
    void client.invalidateQueries({ queryKey: queries.viewing().queryKey });
  });
}

/**
 * Reads movies and series again once the main process has fetched new lists, and a title's
 * details once TMDB's arrived after them.
 */
export function syncOnDemand(client: QueryClient): () => void {
  const stopDetails = listen("ondemand.detailsChanged", ({ kind, ...version }) => {
    void client.invalidateQueries({ queryKey: queries.details(kind, version).queryKey });
  });
  const stopLists = listen("ondemand.updated", () => {
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
  return () => {
    stopDetails();
    stopLists();
  };
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
