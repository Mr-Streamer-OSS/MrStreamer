// The movie and series catalogue as plain data and functions: indexing what the provider sent,
// finding titles by id and searching them; collections.ts builds the lists the UI shows. Display
// names are worked out here, on load, so naming rules improve without fetching again. The
// language versions of one film, which share a TMDB id, become one title that shows the version
// suiting the viewer's language.
import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import type { OnDemandCatalogue, ProviderCategory, ProviderTitle } from "../provider.ts";
import { normalize } from "../text.ts";
import { suitability } from "./languages.ts";
import { titleName, type TitleName } from "./names.ts";

/** How many titles of each kind a search returns. */
export const SEARCH_LIMIT = 60;

/** Category names that say the category is for adults: "XXX | FOR ADULTS", "ADULT 18+". */
const ADULT_CATEGORY = /(?<![\p{L}\p{N}])(xxx|adults?|18\+|porn)(?![\p{L}\p{N}])/iu;

interface IndexedKind {
  readonly titles: readonly Title[];
  /** Every version's id, to the title it belongs to. */
  readonly byId: ReadonlyMap<string, Title>;
  /** Folded names, index-aligned with `titles`, worked out on the first search. */
  readonly searchNames: () => readonly string[];
}

export interface IndexedCatalogue {
  /** The language whose versions the titles show. */
  readonly language: string;
  readonly movies: IndexedKind;
  readonly series: IndexedKind;
}

/** The catalogue for a viewer whose language is `language`, an ISO 639-1 code. */
export function indexCatalogue(catalogue: OnDemandCatalogue, language: string): IndexedCatalogue {
  return {
    language,
    movies: indexKind("movie", catalogue.movieCategories, catalogue.movies, language),
    series: indexKind("series", catalogue.seriesCategories, catalogue.series, language),
  };
}

function indexKind(
  kind: TitleKind,
  rawCategories: readonly ProviderCategory[],
  raw: readonly ProviderTitle[],
  language: string,
): IndexedKind {
  // The adult flag is a standard field; a category named for adults also counts.
  const adultCategories = new Set(
    rawCategories.filter((category) => ADULT_CATEGORY.test(category.name)).map(({ id }) => id),
  );
  // One group per film: the versions sharing a TMDB id, or a row on its own without one.
  const groups = new Map<string, ProviderTitle[]>();
  const seen = new Set<string>();
  for (const item of raw) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const key = item.tmdbId ? `tmdb:${item.tmdbId}` : `id:${item.id}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const titles: Title[] = [];
  /** Every version's name, title by title, for search. */
  const names: string[] = [];
  const byId = new Map<string, Title>();
  for (const group of groups.values()) {
    const versions = group.map((item) => ({ item, name: titleName(item.name, item.releaseDate) }));
    if (versions.length > 1) {
      versions.sort((a, b) => preference(b, language) - preference(a, language));
    }
    const first = versions[0] as Version;
    // What the first version lacks, another may have; one pass, as most films have one version.
    let year = first.name.year;
    let posterUrl = first.item.posterUrl;
    let backdropUrl = first.item.backdropUrl;
    let rating = 0;
    let addedAt = 0;
    let adult = false;
    for (const { item, name } of versions) {
      year ??= name.year;
      posterUrl ??= item.posterUrl;
      backdropUrl ??= item.backdropUrl;
      rating = Math.max(rating, item.rating ?? 0);
      addedAt = Math.max(addedAt, item.addedAt ?? 0);
      adult ||= item.adult || item.categoryIds.some((id) => adultCategories.has(id));
    }
    const categoryIds =
      versions.length === 1
        ? first.item.categoryIds
        : [...new Set(group.flatMap((item) => item.categoryIds))];
    const title: Title = {
      kind,
      id: first.item.id,
      name: first.item.name,
      title: first.name.title,
      tags: first.name.tags,
      year,
      posterUrl,
      backdropUrl,
      rating: rating || null,
      addedAt: addedAt || null,
      categoryIds,
      adult,
      tmdbId: first.item.tmdbId ?? null,
      genres: [],
      versions: versions.map(({ item, name }) => ({ id: item.id, tags: name.tags })),
    };
    titles.push(title);
    names.push(versions.length === 1 ? first.item.name : group.map((item) => item.name).join(" "));
    for (const { item } of versions) byId.set(item.id, title);
  }
  return {
    titles,
    byId,
    searchNames: once(() =>
      titles.map((title, index) => normalize(`${title.title} ${names[index] ?? ""}`)),
    ),
  };
}

export function kindOf(catalogue: IndexedCatalogue, kind: TitleKind): IndexedKind {
  return kind === "movie" ? catalogue.movies : catalogue.series;
}

/** Titles by id, in the order asked, skipping ids the catalogue doesn't have. */
export function byIds(
  catalogue: IndexedCatalogue,
  kind: TitleKind,
  ids: readonly string[],
): Title[] {
  const { byId } = kindOf(catalogue, kind);
  return ids.flatMap((id) => byId.get(id) ?? []);
}

/**
 * Titles whose name holds every word of the query. Names that start with it rank first, then
 * names with a word starting with it; ties go to the newest. Titles for adults are left out.
 */
export function search(
  catalogue: IndexedCatalogue,
  kind: TitleKind,
  query: string,
  limit = SEARCH_LIMIT,
): Title[] {
  const folded = normalize(query);
  if (!folded) return [];
  const words = folded.split(" ");
  const indexed = kindOf(catalogue, kind);
  const { titles } = indexed;
  const searchNames = indexed.searchNames();
  const ranked: { title: Title; rank: number }[] = [];
  for (const [index, title] of titles.entries()) {
    const name = searchNames[index] ?? "";
    if (title.adult || !words.every((word) => name.includes(word))) continue;
    const rank = name.startsWith(folded) ? 0 : ` ${name}`.includes(` ${folded}`) ? 1 : 2;
    ranked.push({ title, rank });
  }
  ranked.sort((a, b) => a.rank - b.rank || (b.title.addedAt ?? 0) - (a.title.addedAt ?? 0));
  return ranked.slice(0, limit).map((entry) => entry.title);
}

interface Version {
  readonly item: ProviderTitle;
  readonly name: TitleName;
}

/** Which version comes first: the one in the language, then the newest. */
function preference(version: Version, language: string): number {
  // Suitability counts most; the date added only breaks ties, scaled below one point.
  return suitability(version.name.tags, language) + (version.item.addedAt ?? 0) / 1e14;
}

function once<A>(make: () => A): () => A {
  let value: { readonly made: A } | null = null;
  return () => (value ??= { made: make() }).made;
}
