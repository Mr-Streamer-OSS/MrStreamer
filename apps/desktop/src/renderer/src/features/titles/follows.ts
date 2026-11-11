// The viewer's followed series as the main process answers them: whether the version shown in a
// series' details is followed, with what its refreshes listed since, and Home's new-episode
// alerts. Every read is the viewer's own; a switch of profile clears them all (see
// features/profiles), and a change sent for the viewer before fails rather than reach another.
import { queryOptions, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { IpcInput } from "@mrstreamer/contracts/ipc";
import type { NewEpisode } from "@mrstreamer/contracts/ondemand";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { call, callForProfile, currentProfile, listen, profileOwner } from "../../lib/ipc.ts";

export const followQueries = {
  /** The follow of this exact version, or null. */
  state: (series: OwnedId) =>
    queryOptions({
      queryKey: ["follows", "state", ownedKey(series)],
      queryFn: () => call("follows.state", { series }),
    }),
  /** Followed series with new episodes, the latest news first, as Home shows them. */
  alerts: () =>
    queryOptions({ queryKey: ["follows", "alerts"], queryFn: () => call("follows.alerts") }),
};

/**
 * Follows or stops following, and marks news seen, as the viewer these controls were drawn for.
 * Each reads the follows again once stored, so the controls show it from their next props.
 */
export function useFollowCommands() {
  const client = useQueryClient();
  const [owner] = useState(profileOwner);

  const settle = async () => {
    if (currentProfile(owner)) await client.invalidateQueries({ queryKey: ["follows"] });
  };

  const set = useMutation({
    mutationFn: ({ series, following }: { series: OwnedId; following: boolean }) =>
      callForProfile(owner, "follows.set", { series, following }),
    onSettled: settle,
  });

  const seen = useMutation({
    mutationFn: (input: IpcInput<"follows.seen">) => callForProfile(owner, "follows.seen", input),
    onSettled: settle,
  });

  return { set, seen };
}

/**
 * Reads the follows again once the main process says this viewer's changed, and once the lists
 * changed: they name each followed series. Lists that newly mark a title for adults drop what
 * was kept rather than show it while it is read again.
 */
function syncFollows(client: QueryClient): () => void {
  const stopOwned = listen("follows.changed", ({ owner }) => {
    if (currentProfile(owner)) void client.invalidateQueries({ queryKey: ["follows"] });
  });

  const stopLists = listen("ondemand.updated", ({ markedForAdults }) => {
    if (markedForAdults) void client.resetQueries({ queryKey: ["follows"] });
    else void client.invalidateQueries({ queryKey: ["follows"] });
  });

  return () => {
    stopOwned();
    stopLists();
  };
}

/** Keeps a view's follow reads current while it is mounted. */
export function useFollowUpdates(): void {
  const client = useQueryClient();
  useEffect(() => syncFollows(client), [client]);
}

/** "S2 E5, S2 E6": the new episodes by their numbers. */
export function newEpisodeLabels(episodes: readonly NewEpisode[]): string {
  return episodes.map((episode) => episodeLabel(episode.season, episode.number)).join(", ");
}
