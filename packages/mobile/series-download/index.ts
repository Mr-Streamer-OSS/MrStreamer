import type { SeriesDetails, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { seriesEpisodeOrder } from "@mrstreamer/core/ondemand/details";

export type EpisodeRef = Extract<TitleRef, { kind: "episode" }>;

export type Scope =
  { readonly kind: "season"; readonly season: number } | { readonly kind: "series" };

/** iOS series admission order: exact files once each, Specials and provider order included. */
export function episodesIn(details: SeriesDetails, version: OwnedId, scope: Scope): EpisodeRef[] {
  const seen = new Set<string>();
  const episodes: EpisodeRef[] = [];

  for (const episode of seriesEpisodeOrder(details)) {
    if (episode.subscriptionId !== version.subscriptionId || episode.seriesId !== version.id) {
      continue;
    }

    if (scope.kind === "season" && episode.season !== scope.season) continue;

    if (seen.has(episode.id)) continue;
    seen.add(episode.id);
    episodes.push({
      kind: "episode",
      subscriptionId: episode.subscriptionId,
      id: episode.id,
      seriesId: episode.seriesId,
      season: episode.season,
      episode: episode.number,
    });
  }

  return episodes;
}
