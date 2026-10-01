// A movie's or series' details as the UI shows them, from what the provider's details call sent.
// Seasons come from the episodes themselves: panels list seasons incompletely, or not at all.
import type {
  Episode,
  MovieDetails,
  Season,
  SeriesDetails,
  Title,
} from "@mrstreamer/contracts/ondemand";
import type { ProviderDetails } from "../provider.ts";
import { episodeName } from "./names.ts";

export function movieDetails(title: Title, details: ProviderDetails): MovieDetails {
  return { kind: "movie", ...shared(title, details) };
}

export function seriesDetails(title: Title, details: ProviderDetails): SeriesDetails {
  const bySeason = new Map<number, Episode[]>();
  const seen = new Set<string>();
  for (const episode of details.episodes) {
    if (seen.has(episode.id)) continue;
    seen.add(episode.id);
    const shown: Episode = {
      id: episode.id,
      seriesId: title.id,
      season: episode.season,
      number: episode.number,
      title: episodeName(episode.name, episode.number),
      plot: episode.plot,
      duration: episode.duration,
      stillUrl: episode.stillUrl,
      airDate: episode.airDate,
    };
    const list = bySeason.get(episode.season);
    if (list) list.push(shown);
    else bySeason.set(episode.season, [shown]);
  }
  const provided = new Map(details.seasons.map((season) => [season.number, season]));
  const seasons = [...bySeason.entries()]
    // Specials, season 0, come after the numbered seasons.
    .sort(([a], [b]) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
    .map(([number, episodes]): Season => {
      const known = provided.get(number);
      return {
        number,
        name: known?.name ?? (number === 0 ? "Specials" : `Season ${number}`),
        posterUrl: known?.posterUrl ?? null,
        episodes: episodes.sort((a, b) => a.number - b.number),
      };
    });
  return { kind: "series", ...shared(title, details), seasons };
}

function shared(title: Title, details: ProviderDetails) {
  return {
    title: {
      ...title,
      posterUrl: title.posterUrl ?? details.posterUrl,
      backdropUrl: details.backdropUrl ?? title.backdropUrl,
    },
    // TMDB's original name first; the provider's often repeats the shown one.
    originalTitle:
      title.originalTitle ??
      (details.originalName && details.originalName !== title.title ? details.originalName : null),
    plot: details.plot,
    genres: details.genres,
    cast: details.cast,
    directors: details.directors,
    releaseDate: details.releaseDate,
    duration: details.duration,
    backdropUrl: details.backdropUrl ?? title.backdropUrl,
  };
}
