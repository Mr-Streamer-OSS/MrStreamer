// React Query bindings for the IPC contract. Components read data through these hooks only.
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { Category } from "../../../shared/library.ts";
import { call, listen } from "./ipc.ts";

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
  search: (query: string) =>
    queryOptions({
      queryKey: ["library", "search", query],
      queryFn: () => call("library.channels", { query }),
      staleTime: Infinity,
      enabled: query.trim().length > 0,
    }),
};

export function useCategories() {
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
