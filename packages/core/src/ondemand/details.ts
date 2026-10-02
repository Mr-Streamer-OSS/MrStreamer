// A movie's or series' details as the UI shows them: TMDB's overview, artwork, genres and credits
// where it has them, the provider's otherwise, and the provider's seasons, episodes and length,
// which are what plays. Seasons come from the episodes themselves: panels list seasons
// incompletely, or not at all. An episode gets TMDB's details once the viewer opens its season.
// The provider's numbers also say which episode comes next.
import type {
  Episode,
  EpisodeDetails,
  MovieDetails,
  Person,
  Season,
  SeriesDetails,
  Title,
} from "@mrstreamer/contracts/ondemand";
import { GENRES, tmdbImage, type EpisodeAbout, type TitleAbout } from "../metadata/tmdb.ts";
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

/**
 * The episode after `current` in the series, in the provider's order: by its season and episode
 * numbers, into the next season after a season's last. Null after the last episode. Specials,
 * season 0, only lead to other specials, so a finale never leads into them. Another file of the
 * same episode, as panels list some twice, is passed over. Undefined when the series doesn't list
 * `current`, as when its details changed since.
 */
export function nextEpisode(
  series: SeriesDetails,
  current: { readonly id?: string; readonly season: number; readonly episode: number },
): Episode | null | undefined {
  const episodes = series.seasons
    .filter((season) => (season.number === 0) === (current.season === 0))
    .flatMap((season) => season.episodes);
  const byId = episodes.findIndex((each) => each.id === current.id);
  const index =
    byId === -1
      ? episodes.findIndex(
          (each) => each.season === current.season && each.number === current.episode,
        )
      : byId;
  const playing = episodes[index];
  if (!playing) return undefined;
  return (
    episodes
      .slice(index + 1)
      .find((each) => each.season !== playing.season || each.number !== playing.number) ?? null
  );
}

/**
 * A season's episodes with TMDB's worked in, matched by number. The provider's episodes are what
 * exists and plays, in its order: episodes only TMDB lists stay out, and one TMDB lacks keeps the
 * provider's. `answers` are TMDB's season in the viewer's language, then in the languages an
 * episode's name falls back to, as titles' names do: English, then the series' own. Without a
 * name in any, the provider's stands. The provider's story comes before one in another language.
 */
export function seasonEpisodes(
  season: Season,
  answers: readonly (readonly EpisodeAbout[])[],
): EpisodeDetails[] {
  const [viewer, ...others] = answers.map(
    (answer) => new Map(answer.map((episode) => [episode.number, episode])),
  );
  return season.episodes.map((episode): EpisodeDetails => {
    const own = viewer?.get(episode.number);
    const fallbacks = others.flatMap((answer) => answer.get(episode.number) ?? []);
    const known = own ?? fallbacks[0];
    return {
      ...episode,
      title: own?.name ?? fallbacks.find((each) => each.name)?.name ?? episode.title,
      plot:
        own?.overview ?? episode.plot ?? fallbacks.find((each) => each.overview)?.overview ?? null,
      duration: episode.duration ?? (known?.runtime ? known.runtime * 60 : null),
      stillUrl: known?.still ? tmdbImage(known.still, 780) : episode.stillUrl,
      airDate: known?.airDate ?? episode.airDate,
      rating: known?.rating ?? null,
      cast: (known?.cast ?? []).map(person),
      directors: known?.directors ?? [],
    };
  });
}

function person(about: TitleAbout["cast"][number]): Person {
  return {
    name: about.name,
    role: about.character,
    photoUrl: about.profile ? tmdbImage(about.profile, 185) : null,
  };
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
    // TMDB's original name, when it answered. Otherwise the provider's, which often repeats the
    // version's own name, marks and all, "Blow 2001 (NL AUDIO)": without them it is mostly the
    // shown one.
    originalTitle: about
      ? otherThan(about.original, title.title)
      : (title.originalTitle ??
        otherThan(details.originalName && titleName(details.originalName).title, title.title)),
    plot: about?.overview ?? details.plot,
    genres: genres.length > 0 ? genres : details.genres,
    cast: about?.cast.length
      ? about.cast.map(person)
      : details.cast.map((name) => ({ name, role: null, photoUrl: null })),
    directors: about?.directors.length ? about.directors : details.directors,
    releaseDate: details.releaseDate,
    // The file's own length, else TMDB's.
    duration: details.duration ?? (about?.runtime ? about.runtime * 60 : null),
    backdropUrl: backdrop ?? details.backdropUrl ?? title.backdropUrl,
  };
}

/** `name`, unless it is the shown one. */
function otherThan(name: string | null | undefined, shown: string): string | null {
  return name && name.toLowerCase() !== shown.toLowerCase() ? name : null;
}
