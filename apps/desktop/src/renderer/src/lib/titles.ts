// Movies and episodes as the views talk about them: how long, how far, what's next, and playing
// one. The player itself is in ../player/title-player.ts.
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { Episode, SeriesDetails, Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import { useUi } from "../app/ui-store.ts";
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

/** Plays a title over everything, from `from` seconds. */
export function playTitle(now: NowPlaying, from: number): void {
  useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
  void titlePlayer.open(now, from);
}

/** How long the pointer rests on a title, or the keyboard on it, before its details load. */
const PREFETCH_AFTER_MS = 200;

/**
 * Loads a title's details while the pointer rests on it or the keyboard selects it, so they are
 * there when it opens: the provider takes a second or so to answer. Spread the returned handlers
 * onto the tile.
 */
export function usePrefetchDetails(title: Title, selected = false) {
  const client = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const start = () => {
    stop();
    timer.current = setTimeout(
      () => void client.prefetchQuery(queries.details(title.kind, title.id)),
      PREFETCH_AFTER_MS,
    );
  };
  useEffect(() => {
    if (selected) start();
    return stop;
  }, [selected, title.kind, title.id]);
  return { onPointerEnter: start, onPointerLeave: stop };
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
  /** What plays: the same title, or the next episode of a finished one. */
  readonly now: NowPlaying;
  readonly from: number;
  /** "38 min left", "Next: S2 E4". */
  readonly line: string;
  /** How far, from 0 to 1; null for a next episode not started. */
  readonly done: number | null;
  readonly artworkUrl: string | null;
}

/**
 * Continue watching from the viewing record, at most `limit`, with what each tile shows. A
 * finished episode offers the next one; a series with nothing left leaves the list, and so do
 * titles the provider no longer lists and titles for adults.
 */
export function useContinueWatching(limit = Infinity): {
  readonly entries: readonly ContinueEntry[];
  readonly loading: boolean;
  readonly error: Error | null;
} {
  const viewing = useQuery(queries.viewing());
  // All of them, at most CONTINUE_LIMIT: the limit applies to what is left to show.
  const items = viewing.data?.continueWatching ?? [];
  const details = useQueries({
    queries: items.map((item) =>
      item.title.kind === "movie"
        ? queries.details("movie", item.title.id)
        : queries.details("series", item.title.seriesId),
    ),
  });
  const loading = viewing.isPending || details.some((each) => each.isPending);
  const shown = items.flatMap((progress, index): Omit<ContinueEntry, "played">[] => {
    const found = details[index]?.data;
    if (!found || found.title.adult) return [];
    const title = progress.title;
    // One entry per film or series, whichever of its versions was played.
    const film = found.title.versions[0]?.id ?? found.title.id;
    if (found.kind === "movie" && title.kind === "movie") {
      return [
        {
          key: `movie:${film}`,
          title: found.title,
          progress,
          now: movieNow(found.title, found.backdropUrl),
          from: resumePoint(progress),
          line: timeLeftOf(progress) ?? "",
          done: progress.position / progress.duration,
          artworkUrl: found.backdropUrl ?? found.title.posterUrl,
        },
      ];
    }
    if (found.kind !== "series" || title.kind !== "episode") return [];
    const current = found.seasons
      .flatMap((season) => season.episodes)
      .find((episode) => episode.id === title.id);
    const next = progress.finished ? nextEpisode(found, title) : current;
    if (!next) return [];
    return [
      {
        key: `series:${film}`,
        title: found.title,
        progress,
        now: episodeNow(found, next),
        from: progress.finished ? 0 : resumePoint(progress),
        line: progress.finished
          ? `Next: ${episodeLabel(next.season, next.number)}`
          : `${episodeLabel(next.season, next.number)} · ${timeLeftOf(progress) ?? ""}`,
        done: progress.finished ? null : progress.position / progress.duration,
        artworkUrl: next.stillUrl ?? found.backdropUrl ?? found.title.posterUrl,
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
