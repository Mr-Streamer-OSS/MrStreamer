// React Query bindings for the IPC contract. Components read data through these hooks only.
import { queryOptions, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
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
};

/** Stars or unstars a channel. The favourites list updates as soon as the main process has it. */
export function useToggleFavourite(): (channelId: string) => void {
  const client = useQueryClient();
  return useCallback(
    (channelId: string) => {
      void call("preferences.toggleFavourite", { channelId }).then(
        (preferences) => client.setQueryData(queries.preferences().queryKey, preferences),
        () => {},
      );
    },
    [client],
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
  const { data } = useQuery(queries.preferences());
  return useMemo(() => new Set(data?.favouriteChannelIds), [data]);
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

/** Asks for programmes again once the main process has a new guide. */
export function syncGuideUpdates(client: QueryClient): () => void {
  return listen("guide.updated", () => {
    void client.invalidateQueries({ queryKey: ["guide"] });
  });
}

/** Keeps the update status current: download progress and outcomes arrive as events. */
export function syncUpdates(client: QueryClient): () => void {
  return listen("updates.changed", (status) => {
    client.setQueryData(queries.updates().queryKey, status);
  });
}
