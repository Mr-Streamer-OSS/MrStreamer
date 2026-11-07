// The viewer's collections as the main process answers them: the column of collections with
// what each holds that the viewer may see, a page of one collection's members, and which
// collections hold one exact source version. Every read is the viewer's own; a switch of
// profile clears them all (see features/profiles), and a read begun for the viewer before fails.
import { queryOptions, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
  collectionKey,
  type CollectionChange,
  type CollectionIdentity,
} from "@mrstreamer/contracts/collections";
import { call, callForProfile, currentProfile, listen, profileOwner } from "../../lib/ipc.ts";

export const collectionQueries = {
  list: () =>
    queryOptions({ queryKey: ["collections", "list"], queryFn: () => call("collections.list") }),
  page: (id: string, offset: number, limit: number) =>
    queryOptions({
      queryKey: ["collections", "page", id, offset, limit],
      queryFn: () => call("collections.page", { id, offset, limit }),
    }),
  /** The collections holding this version, by its own subscription and provider id. */
  memberships: (title: CollectionIdentity) =>
    queryOptions({
      queryKey: ["collections", "memberships", collectionKey(title)],
      queryFn: () =>
        call("collections.memberships", {
          sourceId: title.sourceId,
          kind: title.kind,
          titleId: title.titleId,
        }),
    }),
};

/**
 * Sends changes, each atomic, in order, as the viewer this view was drawn for. Resolves once all
 * are stored and the collections were read again, so the controls show them from their next
 * props; rejects at the first refused, after reading again what the ones before it stored. A
 * change sent again after a switch of profile fails rather than going to the profile now in use.
 */
export function useCommitCollection(): (
  changes: CollectionChange | readonly CollectionChange[],
) => Promise<void> {
  const client = useQueryClient();
  const [owner] = useState(profileOwner);

  return useCallback(
    async (changes: CollectionChange | readonly CollectionChange[]) => {
      try {
        for (const change of "kind" in changes ? [changes] : changes)
          await callForProfile(owner, "collections.change", change);
      } finally {
        if (currentProfile(owner)) await client.invalidateQueries({ queryKey: ["collections"] });
      }
    },
    [client, owner],
  );
}

/**
 * Reads the collections again once the main process says this viewer's changed, and once the
 * lists of titles changed: they say which members are available, and with what artwork. Lists
 * that marked a member for adults drop what was read before, rather than show it while asking.
 */
function syncCollections(client: QueryClient): () => void {
  const read = () => {
    // Cancel an older first read too: invalidation alone may reuse it as the new answer.
    void client.cancelQueries({
      queryKey: ["collections"],
      predicate: (query) => query.state.data === undefined,
    });
    void client.invalidateQueries({ queryKey: ["collections"] });
  };

  const stopOwned = listen("collections.changed", ({ owner }) => {
    if (currentProfile(owner)) read();
  });

  const stopLists = listen("ondemand.updated", ({ markedForAdults }) => {
    if (markedForAdults) void client.resetQueries({ queryKey: ["collections"] });
    else read();
  });

  return () => {
    stopOwned();
    stopLists();
  };
}

/** Keeps a view's collection reads current while it is mounted. */
export function useCollectionUpdates(): void {
  const client = useQueryClient();
  useEffect(() => syncCollections(client), [client]);
}
