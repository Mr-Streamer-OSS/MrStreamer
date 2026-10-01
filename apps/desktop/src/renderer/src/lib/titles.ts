// Movies and episodes as the views talk about them: how long, how far, what's next, which version
// plays, and playing one. The player itself is in ../player/title-player.ts.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Episode, SeriesDetails, Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import { openDetails, useUi } from "../app/ui-store.ts";
import { titlePlayer, type NowPlaying } from "../player/title-player.ts";
import { call } from "./ipc.ts";
import { queries } from "./queries.ts";

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

/** "S2 E3". Specials, season 0, are "Special 3". */
export function episodeLabel(season: number, episode: number): string {
  return season === 0 ? `Special ${episode}` : `S${season} E${episode}`;
}

/** Where a title starts: where it stopped, a few seconds back, or the beginning. */
export function resumePoint(progress: TitleProgress | undefined): number {
  if (!progress || progress.finished) return 0;
  return Math.max(0, progress.position - 5);
}

/** The episode after `current` in the series, crossing into the next season; null at the end. */
export function nextEpisode(
  series: SeriesDetails,
  current: { readonly season: number; readonly episode: number },
): Episode | null {
  const episodes = series.seasons.flatMap((season) => season.episodes);
  const index = episodes.findIndex(
    (each) => each.season === current.season && each.number === current.episode,
  );
  return index === -1 ? null : (episodes[index + 1] ?? null);
}

function episodeRef(episode: Episode): TitleRef {
  return {
    kind: "episode",
    id: episode.id,
    seriesId: episode.seriesId,
    season: episode.season,
    episode: episode.number,
  };
}

/** What the player shows for an episode: the series, and "S2 E3 · Its name". */
export function episodeNow(series: SeriesDetails, episode: Episode): NowPlaying {
  return {
    title: episodeRef(episode),
    name: series.title.title,
    detail: `${episodeLabel(episode.season, episode.number)} · ${episode.title}`,
    artworkUrl: episode.stillUrl ?? series.backdropUrl ?? series.title.posterUrl,
  };
}

export function movieNow(title: Title, backdropUrl: string | null): NowPlaying {
  return {
    title: { kind: "movie", id: title.id },
    name: title.title,
    detail: title.year ? String(title.year) : null,
    artworkUrl: backdropUrl ?? title.posterUrl,
  };
}

/**
 * The version the viewer picked for `title`, while the provider still lists it; null plays the
 * one that suits best. Picks are remembered by kind and TMDB id: only titles with an id gather
 * several versions.
 */
export function pickedVersion(title: Title, preferences: Preferences | undefined): string | null {
  const id = title.tmdbId && preferences?.titleVersions?.[`${title.kind}:${title.tmdbId}`];
  return id && title.versions.some((version) => version.id === id) ? id : null;
}

/**
 * The version that plays unless the viewer picks one: the one a movie stopped in partway, the
 * one a series was watched in last, else the one that suits best.
 */
export function automaticVersion(title: Title, progress: readonly TitleProgress[]): string {
  const latest = progress.toSorted((a, b) => b.at - a.at)[0];
  if (latest?.title.kind === "episode") return latest.title.seriesId;
  return latest && !latest.finished && latest.position > 0 ? latest.title.id : title.id;
}

/** Remembers the version to play for `title`, or forgets the pick for null. */
export function usePickVersion(): (title: Title, id: string | null) => void {
  const client = useQueryClient();
  return (title, id) => {
    if (!title.tmdbId) return;
    const key = `${title.kind}:${title.tmdbId}`;
    const { queryKey } = queries.preferences();
    const previous = client.getQueryData(queryKey);
    const { [key]: _old, ...others } = previous?.titleVersions ?? {};
    const titleVersions = id === null ? others : { ...others, [key]: id };
    if (previous) client.setQueryData(queryKey, { ...previous, titleVersions });
    void call("preferences.update", { titleVersions }).then(
      (saved) => client.setQueryData(queryKey, saved),
      () => client.invalidateQueries({ queryKey }),
    );
  };
}

/** Plays a title over everything, from `from` seconds. */
export function playTitle(now: NowPlaying, from: number): void {
  useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
  void titlePlayer.open(now, from);
}

/** Takes movies, or episodes' series, out of Continue watching: every version played. */
export function removeFromContinue(...titles: readonly TitleRef[]): void {
  for (const title of titles) {
    void call("viewing.removeFromContinue", { commandId: crypto.randomUUID(), title }).catch(
      () => {},
    );
  }
}

/** One Continue watching entry, ready to show and play. */
export interface ContinueEntry {
  readonly key: string;
  /** The movie, or the series. */
  readonly title: Title;
  /** What the viewer played last. */
  readonly progress: TitleProgress;
  /** Every version of it played, which Remove takes out. */
  readonly played: readonly TitleRef[];
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
export function useContinueWatching(limit = Infinity): {
  readonly entries: readonly ContinueEntry[];
  readonly loading: boolean;
  readonly error: Error | null;
} {
  const viewing = useQuery(queries.viewing());
  // All of them, at most CONTINUE_LIMIT: the limit applies to what is left to show.
  const items = viewing.data?.continueWatching ?? [];
  const ids = (kind: "movie" | "episode") =>
    items.flatMap((item) =>
      item.title.kind !== kind
        ? []
        : [item.title.kind === "movie" ? item.title.id : item.title.seriesId],
    );
  const movies = useQuery(queries.titles("movie", ids("movie")));
  const series = useQuery(queries.titles("series", ids("episode")));
  const byVersion = new Map(
    [...(movies.data ?? []), ...(series.data ?? [])].flatMap((title) =>
      title.versions.map((version) => [`${title.kind}:${version.id}`, title] as const),
    ),
  );
  const loading =
    viewing.isPending ||
    (movies.isPending && movies.fetchStatus !== "idle") ||
    (series.isPending && series.fetchStatus !== "idle");
  const shown = items.flatMap((progress): Omit<ContinueEntry, "played">[] => {
    const ref = progress.title;
    const title = byVersion.get(
      ref.kind === "movie" ? `movie:${ref.id}` : `series:${ref.seriesId}`,
    );
    if (!title || title.adult) return [];
    // One entry per film or series, whichever of its versions was played.
    const key = `${title.kind}:${title.tmdbId ?? title.id}`;
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
    const earlier = entries.get(entry.key);
    entries.set(
      entry.key,
      earlier
        ? { ...earlier, played: [...earlier.played, entry.progress.title] }
        : { ...entry, played: [entry.progress.title] },
    );
  }
  return { entries: [...entries.values()].slice(0, limit), loading, error: viewing.error };
}

/**
 * Plays a Continue watching entry: a movie at once, where it stopped; an episode, or the one after
 * a finished one, once the series' details arrive, since only they list the episodes. A series
 * with nothing after the finished episode opens its details instead. Both play the version picked
 * for the title, when there is one.
 */
export function useResume(): (entry: ContinueEntry) => void {
  const client = useQueryClient();
  const preferences = useQuery(queries.preferences()).data;
  return ({ title, progress }) => {
    const ref = progress.title;
    // A version picked since plays instead, from the same point.
    const picked = pickedVersion(title, preferences);
    if (ref.kind === "movie") {
      const id = picked ?? ref.id;
      playTitle(movieNow({ ...title, id }, title.backdropUrl), resumePoint(progress));
      return;
    }
    const seriesId = picked ?? ref.seriesId;
    const open = () => openDetails({ kind: "series", id: seriesId });
    void client.fetchQuery(queries.details("series", seriesId)).then((found) => {
      if (found.kind !== "series") return open();
      const episodes = found.seasons.flatMap((season) => season.episodes);
      const current =
        episodes.find((episode) => episode.id === ref.id) ??
        episodes.find((episode) => episode.season === ref.season && episode.number === ref.episode);
      const next = progress.finished ? nextEpisode(found, ref) : current;
      if (!next) return open();
      playTitle(episodeNow(found, next), progress.finished ? 0 : resumePoint(progress));
    }, open);
  };
}
