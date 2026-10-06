// Movies and episodes as the views talk about them: how long, how far, what's next, which version
// plays, and playing one. The player itself is in ../player/title-player.ts. A version is named
// with its subscription throughout, and so is what plays. A title can gather versions of several
// subscriptions: one of them plays, and how far it got is that version's subscription's alone.
import {
  isCancelledError,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { seriesOf, type Title } from "@mrstreamer/contracts/ondemand";
import type { SubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { CONTINUE_LIMIT, type TitleProgress } from "@mrstreamer/contracts/viewing";
import { nextEpisode } from "@mrstreamer/core/ondemand/details";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { openDetails, useUi } from "../app/ui-store.ts";
import { episodeNow, titlePlayer, type NowPlaying } from "../player/title-player.ts";
import { call } from "./ipc.ts";
import { queries, updateSubscriptionPreferences } from "./queries.ts";

/** "1 h 39 min", "45 min". */
export function runtime(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "38 min left", or null when there's nothing to say. */
export function timeLeftOf(progress: TitleProgress | undefined): string | null {
  if (!progress || progress.finished) return null;
  return `${runtime(progress.duration - progress.position)} left`;
}

/** "1:02:13" or "24:51": a position on a scrubber. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Where a title starts: where it stopped, a few seconds back, or the beginning. */
export function resumePoint(progress: TitleProgress | undefined): number {
  if (!progress || progress.finished) return 0;
  return Math.max(0, progress.position - 5);
}

/**
 * What the player shows for a movie, which plays the version `title` names; episodes have
 * `episodeNow` in the player.
 */
export function movieNow(title: Title, backdropUrl: string | null): NowPlaying {
  return {
    title: { kind: "movie", ...ownedId(title) },
    name: title.title,
    detail: title.year ? String(title.year) : null,
    artworkUrl: backdropUrl ?? title.posterUrl,
    originalLanguage: title.originalLanguage,
  };
}

/** What the viewer left each saved subscription at, by its id: where picks are kept. */
export type Picks = ReadonlyMap<string, SubscriptionPreferences>;

/**
 * The version the viewer picked for `title`, while its provider still lists it; null plays the
 * one that suits best. A pick is kept by the subscription of the version picked, by kind and TMDB
 * id: only titles with an id gather several versions.
 */
export function pickedVersion(title: Title, picks: Picks | undefined): OwnedId | null {
  if (!title.tmdbId || !picks) return null;
  const key = `${title.kind}:${title.tmdbId}`;
  const picked = title.versions.find(
    ({ subscriptionId, id }) => picks.get(subscriptionId)?.titleVersions?.[key] === id,
  );
  return picked ? ownedId(picked) : null;
}

/** The picks the page holds for the subscriptions that list `title`, without asking for any. */
function heldPicks(client: QueryClient, title: Title): Picks {
  const held = new Map<string, SubscriptionPreferences>();
  for (const { subscriptionId } of title.versions) {
    const left = client.getQueryData(queries.subscriptionPreferences(subscriptionId).queryKey);
    if (left) held.set(subscriptionId, left);
  }
  return held;
}

/**
 * The version that plays unless the viewer picked one: the one the title was opened on, when the
 * opener `asked` for it, as a 4K tile opens its 4K version, or when it is another than the one the
 * title shows first; else the one a movie stopped in partway, or a series was watched in last;
 * else the one that suits best.
 */
export function automaticVersion(
  title: Title,
  progress: readonly TitleProgress[],
  opened: OwnedId,
  asked = false,
): OwnedId {
  if (
    (asked || !sameOwned(opened, title)) &&
    title.versions.some((version) => sameOwned(version, opened))
  ) {
    return ownedId(opened);
  }
  const latest = progress.toSorted((a, b) => b.at - a.at)[0];
  if (latest?.title.kind === "episode") return seriesOf(latest.title);
  return ownedId(latest && !latest.finished && latest.position > 0 ? latest.title : title);
}

/**
 * Remembers the version to play for `title`, or forgets the pick for null. The pick goes among
 * those of the version's own subscription, and out of every other that lists the title, so one
 * version is picked at most.
 */
export function usePickVersion(): (title: Title, version: OwnedId | null) => void {
  const client = useQueryClient();
  return (title, version) => {
    if (!title.tmdbId) return;
    const key = `${title.kind}:${title.tmdbId}`;
    for (const subscriptionId of new Set(title.versions.map((each) => each.subscriptionId))) {
      const picks = queries.subscriptionPreferences(subscriptionId);
      // The picks as saved, so one never replaces the others.
      void client
        .ensureQueryData(picks)
        .then(async (previous) => {
          const { [key]: old, ...others } = previous.titleVersions ?? {};
          const mine = version?.subscriptionId === subscriptionId ? version.id : undefined;
          if (old === mine) return;
          const titleVersions = mine === undefined ? others : { ...others, [key]: mine };
          client.setQueryData(picks.queryKey, { ...previous, titleVersions });
          await updateSubscriptionPreferences(client, subscriptionId, { titleVersions });
        })
        .catch(() => client.invalidateQueries({ queryKey: picks.queryKey }));
    }
  };
}

/** Plays a title over everything, from `from` seconds. */
export function playTitle(now: NowPlaying, from: number): void {
  useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
  void titlePlayer.open(now, from);
}

/**
 * Takes a movie or series out of Continue watching, every version of it played, and keeps how far
 * it got for a later Resume. The lists update once the main process has it; `error` says why the
 * last removal failed.
 */
export function useRemoveFromContinue() {
  return useMutation({
    mutationFn: (title: Title) => {
      const versions = title.versions.map(ownedId);
      return call("viewing.removeFromContinue", {
        commandId: crypto.randomUUID(),
        titles: title.kind === "movie" ? { movies: versions } : { series: versions },
      });
    },
  });
}

/** Whether Continue watching holds a version of `title`, which Remove would take out. */
export function useInContinueWatching(title: Title): boolean {
  const viewing = useQuery(queries.viewing());
  const versions = new Set(title.versions.map(ownedKey));
  return (viewing.data?.continueWatching ?? []).some(({ title: played }) =>
    played.kind === "movie"
      ? title.kind === "movie" && versions.has(ownedKey(played))
      : title.kind === "series" && versions.has(ownedKey(seriesOf(played))),
  );
}

/** One Continue watching entry, ready to show and play. */
export interface ContinueEntry {
  readonly key: string;
  /** The movie, or the series. */
  readonly title: Title;
  /** What the viewer played last. */
  readonly progress: TitleProgress;
  /** "38 min left", "S2 E3 · 12 min left", "Next episode". */
  readonly line: string;
  /** How far, from 0 to 1; null for a next episode not started. */
  readonly done: number | null;
  readonly artworkUrl: string | null;
}

/**
 * Continue watching from the viewing record, at most `limit`, with what each tile shows. The
 * titles come from the lists, so showing the row asks the provider nothing; titles the provider
 * no longer lists, and titles for adults, are left out. A finished episode offers the next one.
 */
export function useContinueWatching(limit = CONTINUE_LIMIT): {
  readonly entries: readonly ContinueEntry[];
  readonly loading: boolean;
  readonly error: Error | null;
} {
  const viewing = useQuery(queries.viewing());
  // All the record offers: the limit applies to what is left to show.
  const items = viewing.data?.continueWatching ?? [];
  /** The version each entry played: the movie, or the episode's series. */
  const played = ({ title }: TitleProgress): OwnedId =>
    title.kind === "movie" ? ownedId(title) : seriesOf(title);
  const versions = (kind: "movie" | "episode") =>
    items.flatMap((item) => (item.title.kind === kind ? [played(item)] : []));
  const movies = useQuery(queries.titles("movie", versions("movie")));
  const series = useQuery(queries.titles("series", versions("episode")));
  const byVersion = new Map(
    [...(movies.data ?? []), ...(series.data ?? [])].flatMap((title) =>
      title.versions.map((version) => [`${title.kind}:${ownedKey(version)}`, title] as const),
    ),
  );
  const loading =
    viewing.isPending ||
    (movies.isPending && movies.fetchStatus !== "idle") ||
    (series.isPending && series.fetchStatus !== "idle");
  const shown = items.flatMap((progress): ContinueEntry[] => {
    const ref = progress.title;
    const title = byVersion.get(
      `${ref.kind === "movie" ? "movie" : "series"}:${ownedKey(played(progress))}`,
    );
    if (!title || title.adult) return [];
    // One entry per film or series, whichever of its versions was played, of whichever
    // subscription: the one played last stands for the rest, and is the one that resumes.
    const { key } = title;
    const artworkUrl = title.backdropUrl ?? title.posterUrl;
    if (ref.kind === "movie") {
      return [
        {
          key,
          title,
          progress,
          line: timeLeftOf(progress) ?? "",
          done: progress.position / progress.duration,
          artworkUrl,
        },
      ];
    }
    return [
      {
        key,
        title,
        progress,
        line: progress.finished
          ? "Next episode"
          : `${episodeLabel(ref.season, ref.episode)} · ${timeLeftOf(progress) ?? ""}`,
        done: progress.finished ? null : progress.position / progress.duration,
        artworkUrl,
      },
    ];
  });
  // Most recent first, so the version played last stands for the rest.
  const entries = new Map<string, ContinueEntry>();
  for (const entry of shown) {
    if (!entries.has(entry.key)) entries.set(entry.key, entry);
  }
  return { entries: [...entries.values()].slice(0, limit), loading, error: viewing.error };
}

/** Rises with every resume, so only the latest acts once its details arrive. */
let resuming = 0;

/**
 * Whether the viewer is where a resume started: the same account, page and overlays. A resume
 * that waited for a series' details gives way to anything done since, a new account above all.
 */
function stillThere(from: ReturnType<typeof useUi.getState>): boolean {
  const now = useUi.getState();
  return (
    now.account === from.account &&
    now.view === from.view &&
    now.watching === from.watching &&
    now.playingTitle === from.playingTitle &&
    now.details === from.details &&
    now.settings === from.settings &&
    now.searchOpen === from.searchOpen
  );
}

/**
 * Plays a Continue watching entry: a movie at once, where it stopped; an episode, or the one after
 * a finished one, once the series' details arrive, since only they list the episodes. A series
 * with nothing after the finished episode opens its details instead. Both resume in the
 * subscription the entry was played in: a version picked since plays instead when it is that
 * subscription's too, and never another's, whose file and episodes are its own. A series that
 * answers after the viewer moved on, or after the account changed, does nothing.
 */
export function useResume(): (entry: ContinueEntry) => void {
  const client = useQueryClient();
  return ({ title, progress }) => {
    const ref = progress.title;
    // A version picked since in the same subscription plays instead, from the same point.
    const pick = pickedVersion(title, heldPicks(client, title));
    const picked = pick?.subscriptionId === ref.subscriptionId ? pick : null;
    if (ref.kind === "movie") {
      const version = picked ?? ownedId(ref);
      playTitle(movieNow({ ...title, ...version }, title.backdropUrl), resumePoint(progress));
      return;
    }
    const series = picked ?? seriesOf(ref);
    const mine = ++resuming;
    const from = useUi.getState();
    const wanted = () => mine === resuming && stillThere(from);
    const open = () => openDetails({ kind: "series", ...series });
    void client.fetchQuery(queries.details("series", series)).then(
      (found) => {
        if (!wanted()) return;
        if (found.kind !== "series") return open();
        const episodes = found.seasons.flatMap((season) => season.episodes);
        const current =
          episodes.find((episode) => sameOwned(episode, ref)) ??
          episodes.find(
            (episode) => episode.season === ref.season && episode.number === ref.episode,
          );
        const next = progress.finished ? nextEpisode(found, ref) : current;
        if (!next) return open();
        playTitle(episodeNow(found, next), progress.finished ? 0 : resumePoint(progress));
      },
      (error: unknown) => {
        // Cancelled when the account changed, or the details failed: open them only if still wanted.
        if (!isCancelledError(error) && wanted()) open();
      },
    );
  };
}
