// A movie's or series' details as the UI shows them: TMDB's overview, artwork, genres, credits and
// runtime where it has them, the provider's otherwise, and the provider's seasons and episodes,
// which are what plays. A provider's length is only what its panel says of the file and can be far
// off, so it fills in where TMDB has no runtime; playback measures the file itself. Seasons come
// from the episodes themselves: panels list seasons incompletely, or not at all, and some episodes
// twice. An episode gets TMDB's details once the viewer opens its season. The provider's numbers
// also say which episode comes next.
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
import type { ProviderDetails, ProviderEpisode } from "../provider.ts";
import { suitability } from "./languages.ts";
import { episodeName, titleName } from "./names.ts";

export function movieDetails(
  title: Title,
  details: ProviderDetails,
  about: TitleAbout | null = null,
): MovieDetails {
  return { kind: "movie", ...shared(title, details, about) };
}

/**
 * A series version's details for a viewer of `language`. One row per episode: where the provider
 * lists two files of the same season and number, as some panels do, the one shown is picked as a
 * title's version is (`preferredFile`). The other still plays by its id, as from Continue watching.
 */
export function seriesDetails(
  title: Title,
  details: ProviderDetails,
  about: TitleAbout | null,
  language: string,
): SeriesDetails {
  const files = new Map<string, ProviderEpisode>();
  for (const episode of details.episodes) {
    const key = `${episode.season}:${episode.number}`;
    const other = files.get(key);
    if (!other || preferredFile(episode, other, language)) files.set(key, episode);
  }
  const bySeason = new Map<number, Episode[]>();
  for (const episode of files.values()) {
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
 * Whether `file` suits a viewer of `language` better than `other`, a file of the same episode: as
 * with versions, by the marks in its name, then the newest.
 */
function preferredFile(file: ProviderEpisode, other: ProviderEpisode, language: string): boolean {
  const fit =
    suitability(titleName(file.name).tags, language) -
    suitability(titleName(other.name).tags, language);
  return fit > 0 || (fit === 0 && (file.addedAt ?? 0) > (other.addedAt ?? 0));
}

/**
 * The episode after `current` in the series, in the provider's order: by its season and episode
 * numbers, into the next season after a season's last. Null after the last episode. Specials,
 * season 0, only lead to other specials, so a finale never leads into them. `current` is found by
 * id, else by its numbers, as a second file of an episode is, which the details don't show.
 * Undefined when the series doesn't list it, as when its details changed since.
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
  if (index === -1) return undefined;
  return episodes[index + 1] ?? null;
}

/**
 * A season's episodes with TMDB's worked in, matched by number. The provider's episodes are what
 * exists and plays, in its order: episodes only TMDB lists stay out, and one TMDB lacks keeps the
 * provider's. `answers` are TMDB's season in the viewer's language, then in the languages an
 * episode's name falls back to, as titles' names do: English, then the series' own. Without a
 * name in any, the provider's stands. The provider's story comes before one in another language.
 * An episode's length is TMDB's runtime, from the first answer that has one, else the provider's.
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
    const [runtime] = [own, ...fallbacks].flatMap((each) => runtimeSeconds(each?.runtime) ?? []);
    return {
      ...episode,
      title: own?.name ?? fallbacks.find((each) => each.name)?.name ?? episode.title,
      plot:
        own?.overview ?? episode.plot ?? fallbacks.find((each) => each.overview)?.overview ?? null,
      duration: runtime ?? episode.duration,
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
    // TMDB's runtime, else what the provider says of the file.
    duration: runtimeSeconds(about?.runtime) ?? details.duration,
    backdropUrl: backdrop ?? details.backdropUrl ?? title.backdropUrl,
  };
}

/** TMDB's runtime, in minutes, as seconds. Null unless it is a length: positive and finite. */
function runtimeSeconds(minutes: number | null | undefined): number | null {
  return minutes && Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
}

/** `name`, unless it is the shown one. */
function otherThan(name: string | null | undefined, shown: string): string | null {
  return name && name.toLowerCase() !== shown.toLowerCase() ? name : null;
}
