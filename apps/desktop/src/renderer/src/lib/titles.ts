// Movies and episodes as the views talk about them: how long, how far, what's next, and playing
// one. The player itself is in ../player/title-player.ts.
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
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
export function usePlayTitle(): (now: NowPlaying, from: number) => void {
  const client = useQueryClient();
  return (now, from) => {
    useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
    void titlePlayer.open(now, from, client.getQueryData(queries.preferences().queryKey));
  };
}

/** Takes a movie, or an episode's series, out of Continue watching. */
export function removeFromContinue(title: TitleRef): void {
  void call("viewing.removeFromContinue", { commandId: crypto.randomUUID(), title }).catch(
    () => {},
  );
}

/** One Continue watching entry, ready to show and play. */
export interface ContinueEntry {
  readonly key: string;
  /** What the viewer played last; Remove takes this out. */
  readonly progress: TitleProgress;
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
 * Continue watching from the viewing record, with what each tile shows. A finished episode
 * offers the next one; a series with nothing left leaves the list. Titles the provider no
 * longer lists leave it too.
 */
export function useContinueWatching(limit: number): {
  readonly entries: readonly ContinueEntry[];
  readonly loading: boolean;
} {
  const viewing = useQuery(queries.viewing());
  const items = (viewing.data?.continueWatching ?? []).slice(0, limit);
  const details = useQueries({
    queries: items.map((item) =>
      item.title.kind === "movie"
        ? queries.details("movie", item.title.id)
        : queries.details("series", item.title.seriesId),
    ),
  });
  const loading = viewing.isPending || details.some((each) => each.isPending);
  const entries = items.flatMap((progress, index): ContinueEntry[] => {
    const found = details[index]?.data;
    if (!found) return [];
    const title = progress.title;
    if (found.kind === "movie" && title.kind === "movie") {
      return [
        {
          key: `movie:${title.id}`,
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
        key: `series:${found.title.id}`,
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
  return { entries, loading };
}
