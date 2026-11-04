import { rememberSubtitleTitle, versionKey } from "../subtitles/context.ts";
import {
  nextEpisode as coreNextEpisode,
  seriesEpisodeOrder,
  episodeFileVersion,
} from "@mrstreamer/core/ondemand/details";
import type { DetailState } from "../library/model.ts";
import type { EpisodeIntent, NextEpisode } from "./media.ts";

/** Uses the selected Library version's order and exact stream containers. */
export function nextEpisode(details: DetailState, current: EpisodeIntent): NextEpisode | undefined {
  if (details.value?.kind !== "series") return undefined;
  const series = details.value;

  const row = seriesEpisodeOrder(series).find(
    (episode) =>
      episode.subscriptionId === current.sourceId &&
      (episode.id === current.id || episode.versions?.some((version) => version.id === current.id)),
  );

  if (!row) return undefined;
  const exact = episodeFileVersion(row, current.id);
  rememberSubtitleTitle({
    key: versionKey(current.sourceId, "episode", current.id, current.container),
    query: {
      kind: "episode",
      season: exact.season,
      episode: exact.number,
      ...(series.title.tmdbId && /^[1-9]\d{0,9}$/.test(series.title.tmdbId)
        ? { tmdbId: Number(series.title.tmdbId) }
        : { title: series.title.title }),
    },
  });

  const episode =
    coreNextEpisode(series, { id: exact.id, season: exact.season, episode: exact.number }) ??
    undefined;

  if (!episode || episode.subscriptionId !== current.sourceId) return undefined;
  const container = details.containers.get(episode.id)?.trim();

  if (!container) return undefined;

  return {
    intent: {
      kind: "title",
      sourceId: episode.subscriptionId,
      media: "episode",
      id: episode.id,
      container,
      title: episode.title,
    },
    label: `S${episode.season} E${episode.number} · ${episode.title}`,
  };
}
