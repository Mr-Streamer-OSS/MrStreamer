import type { Episode, SeriesDetails, Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import { ownedId, ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { nextEpisode } from "@mrstreamer/core/ondemand/details";
import { resumePoint } from "@mrstreamer/core/viewing/continue";
import { finishes, nextUnwatched } from "@mrstreamer/core/viewing/episodes";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { streamLogin } from "./account.ts";
import { play, type Playing } from "./playback.ts";
import { store, useStore } from "./store.ts";
import { titleFile } from "./titles.ts";
import { finishSeries, recordProgress, seriesViewing } from "./viewing.ts";

// Playing a movie or an episode in the one player, as the desktop's title player decides it:
// from where it stopped, saving how far it got in the viewing record against when this play
// began, the next episode not yet watched, and a series finished once its last episode ends with
// none left. Any file is tried, whatever its name or type says: a version that fails is noted as
// one that didn't play here, for the details' version menu, until it plays.

const failed = store<ReadonlySet<string>>(new Set());
/** Versions, by `ownedKey`, that failed to play since launch. */
export const useFailedVersions = () => useStore(failed);
/** The same, as it stands now, for a menu opened later than the screen last drew. */
export const failedVersions = () => failed.get();

function noted(key: string, played: boolean) {
  failed.set((current) => {
    if (current.has(key) === !played) return current;
    const next = new Set(current);
    if (played) next.delete(key);
    else next.add(key);
    return next;
  });
}

/** Where the details of a title are, to show its versions after one failed. */
export type ShowVersions = () => void;

const sourceOf = (ref: TitleRef) => async (signal: AbortSignal) => {
  const file = await titleFile(ref, signal);
  return {
    url: file.url,
    hls: file.container === "m3u8",
    ...(file.headers ? { headers: file.headers } : {}),
  };
};

/** Plays a movie's `version` in Watch, from `from` seconds. */
export function playMovie(title: Title, version: OwnedId, from: number, versions: ShowVersions) {
  const ref: TitleRef = { kind: "movie", ...ownedId(version) };
  const since = Date.now();
  const key = ownedKey(version);
  const item: Playing = {
    id: key,
    title: title.title,
    place: title.year ? String(title.year) : "",
    live: false,
    next: false,
    versions: title.versions.length > 1,
  };
  void play(item, sourceOf(ref), {
    watch: true,
    login: streamLogin(),
    from,
    progress: (position, duration) =>
      void recordProgress(ref, position, duration, since).catch(() => undefined),
    outcome: (played) => noted(key, played),
    versions,
  });
}

/** Plays an episode of `details`, a series version, in Watch, from `from` seconds. */
export function playEpisode(
  details: SeriesDetails,
  episode: Episode,
  from: number,
  versions: ShowVersions,
) {
  const ref: TitleRef = {
    kind: "episode",
    subscriptionId: episode.subscriptionId,
    id: episode.id,
    seriesId: episode.seriesId,
    season: episode.season,
    episode: episode.number,
  };
  const series = { subscriptionId: episode.subscriptionId, id: episode.seriesId };
  const since = Date.now();
  const key = ownedKey(episode);
  const at = { id: episode.id, season: episode.season, episode: episode.number };
  /** The episode after this one in the series' order; null at the last. */
  const after = nextEpisode(details, at) ?? null;
  let finishing = false;
  const standing = () => seriesViewing(series);
  const item: Playing = {
    id: key,
    title: details.title.title,
    place: `${episodeLabel(episode.season, episode.number)} · ${episode.title}`,
    live: false,
    next: after !== null,
    versions: false,
  };
  void play(item, sourceOf(ref), {
    watch: true,
    login: streamLogin(),
    from,
    progress: (position, duration) => {
      const saved = recordProgress(ref, position, duration, since);
      if (after !== null || finishing || !isFinished(position, duration)) return;
      // In the credits of an episode with none after it: once the progress is saved, the series
      // is finished if the record says no numbered episode is left to watch.
      finishing = true;
      void saved
        .then(standing)
        .then(({ progress, marks }) =>
          finishes(details, { ...ref, id: episode.id, since }, progress, marks)
            ? finishSeries(details.title.versions.map(ownedId), since)
            : (finishing = false),
        )
        .catch(() => (finishing = false));
    },
    outcome: (played) => noted(key, played),
    // The next one not yet watched, as the record stands now, else the next in order.
    next: () =>
      void standing().then(
        ({ progress, marks }) => {
          const upcoming = nextUnwatched(details, at, progress, marks) ?? after;
          if (!upcoming) return;
          const kept = progress.find(
            ({ title }) => title.kind === "episode" && title.id === upcoming.id,
          );
          playEpisode(details, upcoming, resumePoint(kept), versions);
        },
        () => after && playEpisode(details, after, 0, versions),
      ),
    versions,
  });
}
