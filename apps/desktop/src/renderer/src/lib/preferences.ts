import type { ActiveProfile } from "@mrstreamer/contracts/profiles";
import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";
import { queryOptions, useQuery, type QueryClient, type QueryOptions } from "@tanstack/react-query";
import type { PreferenceSnapshot } from "@mrstreamer/contracts/ipc";
import { DEFAULT_SEEK_STEP, type Preferences } from "@mrstreamer/contracts/preferences";
import {
  call,
  callForProfile,
  listen,
  profileOwner,
  currentProfile,
  currentProfileReply,
  ownProfileReply,
} from "./ipc.ts";

const key = ["preferences"] as const;
let connected: QueryClient | undefined;

/** Synchronous cache observers can deliver another snapshot before the current call returns. */
const applying = new WeakSet<QueryClient>();

const consumers = new WeakMap<
  QueryClient,
  {
    apply: (preferences: Preferences) => void;
    hideAdults: () => void;
  }
>();

/** All IPC replies/events enter here. The query cache alone holds authoritative preferences. */
export function acceptPreferences(
  client: QueryClient,
  incoming: PreferenceSnapshot,
): PreferenceSnapshot {
  if (!currentProfileReply(incoming))
    throw new Error("Viewing profile changed before preferences were accepted.");
  const previous = client.getQueryData<PreferenceSnapshot>(key);

  if (previous && previous.revision >= incoming.revision) return previous;
  const delivering = applying.has(client);
  applying.add(client);

  try {
    client.setQueryData(key, incoming);

    // The outer delivery drains the cache, including any newer snapshot an observer accepted.
    if (delivering) return client.getQueryData<PreferenceSnapshot>(key) ?? incoming;
    let applied = previous;

    while (true) {
      const latest = client.getQueryData<PreferenceSnapshot>(key) ?? incoming;

      if (applied && applied.revision >= latest.revision) return latest;
      consumers.get(client)?.apply(latest.preferences);
      applyChanges(client, applied, latest);
      applied = latest;
    }
  } finally {
    if (!delivering) applying.delete(client);
  }
}

function applyChanges(
  client: QueryClient,
  previous: PreferenceSnapshot | undefined,
  incoming: PreferenceSnapshot,
): void {
  if (previous) {
    const before = previous.preferences;
    const after = incoming.preferences;
    const adult = !!before.adultTitles !== !!after.adultTitles;
    const titles = before.titleLanguage !== after.titleLanguage || before.tmdbKey !== after.tmdbKey;

    if (adult) {
      if (!after.adultTitles) consumers.get(client)?.hideAdults();

      for (const group of ["library", "guide", "watchlist", "collections"]) {
        void client.resetQueries({
          queryKey: [group],
          predicate: (query) => group !== "watchlist" || query.queryKey[1] !== "availability",
        });
      }

      // Keep only the last availability answer while titles are discarded and read again.
      void client.cancelQueries({ queryKey: ["watchlist", "availability"] });
      void client.invalidateQueries({ queryKey: ["watchlist", "availability"] });
    }

    if (adult || titles) {
      // Cancel old first reads too: invalidation alone may reuse them as the new answer.
      const groups = titles && !adult ? ["ondemand", "watchlist"] : ["ondemand"];

      for (const group of groups) {
        void client.cancelQueries({ queryKey: [group] });
        void client.invalidateQueries({ queryKey: [group] });
      }
    }
  }
}

const Revisioned = lazy(() => type({ revision: "number | number.NaN" }));

/** React Query's own queryFn completion must also preserve a newer event already in its cache. */
const newest: Exclude<
  QueryOptions<PreferenceSnapshot>["structuralSharing"],
  boolean | undefined
> = (previous, incoming) => {
  if (Revisioned().allows(incoming) && !currentProfileReply(incoming)) return previous;

  if (
    Revisioned().allows(previous) &&
    Revisioned().allows(incoming) &&
    previous.revision >= incoming.revision
  )
    return previous;

  return incoming;
};

export const preferenceQuery = () =>
  queryOptions({
    queryKey: key,
    queryFn: async ({ client }) => {
      const snapshot = await call("preferences.get");

      return acceptPreferences(client, snapshot);
    },
    select: (snapshot) => snapshot.preferences,
    structuralSharing: newest,
    staleTime: Infinity,
  });

/** Reads the committed cache without starting another request. Pending editors keep only intent. */
export function currentPreferences(client = connected): Preferences | undefined {
  return client?.getQueryData<PreferenceSnapshot>(key)?.preferences;
}

/** Seconds the skip keys and buttons move, as saved: for key handlers, which read it as pressed. */
export function seekStep(preferences = currentPreferences()): number {
  return preferences?.seekStepSeconds ?? DEFAULT_SEEK_STEP;
}

/**
 * `seekStep` for skip buttons, which name the step and follow it as Settings changes it. They only
 * follow the cache the app keeps: a button never starts a read of its own.
 */
export function useSeekStep(): number {
  return seekStep(useQuery({ ...preferenceQuery(), enabled: false }).data);
}

/** Players can read/save outside React; composition attaches their renderer cache once. */
export async function readPreferences(client = connected): Promise<Preferences> {
  const owner = profileOwner();

  try {
    const snapshot = await call("preferences.get");

    return (client ? acceptPreferences(client, snapshot) : snapshot).preferences;
  } catch (error) {
    if (client && currentProfile(owner))
      void client.invalidateQueries({ queryKey: key, refetchType: "none" });
    throw error;
  }
}

export async function updatePreferences(
  patch: Partial<Preferences>,
  client = connected,
  owner: ActiveProfile | null = profileOwner(),
): Promise<Preferences> {
  const snapshot = await callForProfile(owner, "preferences.update", patch);

  return (client ? acceptPreferences(client, snapshot) : snapshot).preferences;
}

/** Install once at renderer composition, never from a component or each player attachment. */
export function syncPreferences(
  client: QueryClient,
  apply: (preferences: Preferences) => void,
  hideAdults: () => void = () => {},
): () => void {
  connected = client;
  consumers.set(client, { apply, hideAdults });
  const current = client.getQueryData<PreferenceSnapshot>(key);

  if (current) apply(current.preferences);

  const changed = listen("preferences.changed", (snapshot) => {
    if (profileOwner() === null) acceptPreferences(client, snapshot);
  });

  const ownedChanged = listen("profiles.preferencesChanged", ({ owner, snapshot }) => {
    if (ownProfileReply(snapshot, owner)) acceptPreferences(client, snapshot);
  });

  const ownedStale = listen("profiles.preferencesStale", ({ owner }) => {
    if (currentProfile(owner)) void client.invalidateQueries({ queryKey: key });
  });

  const stale = listen("preferences.stale", () => {
    if (profileOwner() !== null) return;
    void client.invalidateQueries({ queryKey: key });
  });

  return () => {
    changed();
    stale();
    ownedChanged();
    ownedStale();
    consumers.delete(client);

    if (connected === client) connected = undefined;
  };
}
