import type { Title, TitleDetails } from "@mrstreamer/contracts/ondemand";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { ChannelRow } from "../connect/sources.ts";
import { exampleId } from "./session.ts";

export const channels: readonly ChannelRow[] = ["Harbour", "Meadow", "Orbit"].map((name, i) => ({
  key: `${exampleId}:${i + 1}`,
  sourceId: exampleId,
  title: `${name} · Example`,
  number: i + 1,
  category: i === 2 ? "Science" : "Culture",
}));

export const titles: readonly Title[] = (["movie", "series"] as const).map((kind) => ({
  kind,
  key: `${exampleId}:${kind}`,
  subscriptionId: exampleId,
  id: kind,
  name: kind === "movie" ? "The Quiet Harbour · Example" : "Orbit Diaries · Example",
  title: kind === "movie" ? "The Quiet Harbour · Example" : "Orbit Diaries · Example",
  originalTitle: null,
  originalLanguage: null,
  tags: [],
  year: 2026,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: null,
  genres: ["Drama"],
  versions: [{ subscriptionId: exampleId, id: kind, tags: [] }],
}));

export function details(title: Title): TitleDetails {
  const base = {
    title,
    originalTitle: null,
    plot: "Fictional local example. Add your provider to watch your own content.",
    genres: title.genres,
    cast: [],
    directors: [],
    releaseDate: null,
    duration: 1800,
    backdropUrl: null,
  };

  return title.kind === "movie"
    ? { ...base, kind: "movie" }
    : {
        ...base,
        kind: "series",
        seasons: [1, 2].map((number) => ({
          number,
          name: `Season ${number}`,
          posterUrl: null,
          episodes: [1, 2].map((episode) => ({
            subscriptionId: exampleId,
            id: `episode-${number}-${episode}`,
            seriesId: title.id,
            season: number,
            number: episode,
            title: `A new horizon ${episode} · Example`,
            plot: "A fictional voyage among the stars.",
            duration: 1800,
            stillUrl: null,
            airDate: null,
          })),
        })),
      };
}

/** Local slots follow the requested day, so offline exploration always includes future actions. */
export function programmes(from: number): readonly Programme[] {
  const hour = 3600000;
  const start = Math.floor(from / hour) * hour;

  return Array.from({ length: 26 }, (_, i) => ({
    start: start + i * hour,
    stop: start + (i + 1) * hour,
    title: `${["Coastal stories", "Beyond the meadow", "Night sky"][i % 3]} · Example`,
    description: "Fictional local programme. No stream or reminder is included.",
  }));
}
