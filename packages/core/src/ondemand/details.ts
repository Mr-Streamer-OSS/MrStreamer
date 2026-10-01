// A movie's or series' details as the UI shows them: TMDB's overview, artwork, genres and credits
// where it has them, the provider's otherwise, and the provider's seasons, episodes and length,
// which are what plays. Seasons come from the episodes themselves: panels list seasons
// incompletely, or not at all.
import type {
  Episode,
  MovieDetails,
  Season,
  SeriesDetails,
  Title,
} from "@mrstreamer/contracts/ondemand";
import { GENRES, tmdbImage, type TitleAbout } from "../metadata/tmdb.ts";
import type { ProviderDetails } from "../provider.ts";
import { episodeName, titleName } from "./names.ts";

export function movieDetails(
  title: Title,
  details: ProviderDetails,
  about: TitleAbout | null = null,
): MovieDetails {
  return { kind: "movie", ...shared(title, details, about) };
}

export function seriesDetails(
  title: Title,
  details: ProviderDetails,
  about: TitleAbout | null = null,
): SeriesDetails {
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
  return { kind: "series", ...shared(title, details, about), seasons };
}

function shared(title: Title, details: ProviderDetails, about: TitleAbout | null) {
  const poster = about?.poster ? tmdbImage(about.poster, 780) : null;
  const backdrop = about?.backdrop ? tmdbImage(about.backdrop, 1280) : null;
  const genres = [...new Set((about?.genres ?? []).flatMap((id) => GENRES[id] ?? []))];
  return {
    title: {
      ...title,
      posterUrl: poster ?? title.posterUrl ?? details.posterUrl,
      backdropUrl: backdrop ?? details.backdropUrl ?? title.backdropUrl,
    },
    // TMDB's original name first. The provider's often repeats the version's own name, marks and
    // all, "Blow 2001 (NL AUDIO)": without them it is mostly the shown one.
    originalTitle: title.originalTitle ?? providerOriginal(details.originalName, title.title),
    plot: about?.overview ?? details.plot,
    genres: genres.length > 0 ? genres : details.genres,
    cast: about?.cast.length
      ? about.cast.map((person) => ({
          name: person.name,
          role: person.character,
          photoUrl: person.profile ? tmdbImage(person.profile, 185) : null,
        }))
      : details.cast.map((name) => ({ name, role: null, photoUrl: null })),
    directors: about?.directors.length ? about.directors : details.directors,
    releaseDate: details.releaseDate,
    // The file's own length, else TMDB's.
    duration: details.duration ?? (about?.runtime ? about.runtime * 60 : null),
    backdropUrl: backdrop ?? details.backdropUrl ?? title.backdropUrl,
  };
}

function providerOriginal(name: string | null, shown: string): string | null {
  const original = name ? titleName(name).title : null;
  return original && original.toLowerCase() !== shown.toLowerCase() ? original : null;
}
