import type { DetailState } from "../library/model.ts";
import type { EpisodeIntent, NextEpisode } from "./media.ts";

/** Uses the selected Library version's order and exact stream containers. */
export function nextEpisode(details: DetailState, current: EpisodeIntent): NextEpisode | undefined {
  if (details.value?.kind !== "series") return undefined;
  const episodes = details.value.seasons.flatMap((season) => season.episodes);

  const index = episodes.findIndex(
    (episode) => episode.subscriptionId === current.sourceId && episode.id === current.id,
  );

  if (index < 0) return undefined;
  const episode = episodes[index + 1];

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
