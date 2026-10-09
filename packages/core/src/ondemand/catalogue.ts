// The movie and series catalogue as plain data and functions: indexing what the providers sent,
// finding titles by id and searching them; collections.ts builds the lists the UI shows. Display
// names are worked out here, on load, so naming rules improve without fetching again. The
// language versions of one film, which share a TMDB id, become one title that shows the version
// suiting the viewer's language. Every title and version says which subscription lists it.
//
// Several subscriptions make one catalogue. A film or series two of them list under the same
// TMDB id is one title with the versions of both, so lists count and show it once, and what plays
// is still one version of one subscription. Nothing joins by name: a row without a TMDB id stays
// on its own, whichever subscription lists another of its name, and so does a row for adults.
import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { adultIn } from "../adult.ts";
import type { OnDemandCatalogue, ProviderTitle } from "../provider.ts";
import { normalize } from "../text.ts";
import { suitability } from "./languages.ts";
import { titleName, type TitleName } from "./names.ts";

/** How many titles of each kind a search returns. */
export const SEARCH_LIMIT = 60;

/** One subscription's lists, as its provider sent them. */
export interface CatalogueSource {
  readonly subscriptionId: string;
  readonly catalogue: OnDemandCatalogue;
}

interface IndexedKind {
  readonly titles: readonly Title[];
  /** Every version, by its `ownedKey`, to the title it belongs to. */
  readonly byId: ReadonlyMap<string, Title>;
  /**
   * The titles whose versions were gathered by a TMDB id, by that id, whichever subscriptions
   * list them: every title with one but those for adults, which stand on their own. Worked out
   * when first asked for.
   */
  readonly byTmdbId: () => ReadonlyMap<string, Title>;
  /** Folded names, index-aligned with `titles`, worked out on the first search. */
  readonly searchNames: () => readonly string[];
}

export interface IndexedCatalogue {
  /** The language whose versions the titles show. */
  readonly language: string;
  readonly movies: IndexedKind;
  readonly series: IndexedKind;
}

/**
 * The catalogue the lists of `sources` make together, in their order, for a viewer whose language
 * is `language`, an ISO 639-1 code. Each kind is indexed when first read, so opening Movies
 * doesn't wait for the series.
 */
export function indexCatalogue(
  sources: readonly CatalogueSource[],
  language: string,
): IndexedCatalogue {
  const movies = once(() => indexKind("movie", sources, language));
  const series = once(() => indexKind("series", sources, language));
  return {
    language,
    get movies() {
      return movies();
    },
    get series() {
      return series();
    },
  };
}

/** A provider's row with its name read, and whether it is for adults. */
interface Named {
  readonly item: ProviderTitle;
  readonly listedOrder: number;
  readonly name: TitleName;
  readonly adult: boolean;
}

/**
 * Each catalogue's rows of a kind with their names read, once: reading them is most of the work
 * of indexing, and another subscription's lists arriving changes nothing about these.
 */
const namedRows = new WeakMap<OnDemandCatalogue, Partial<Record<TitleKind, readonly Named[]>>>();

/** A catalogue's rows of a kind, each id once. */
function namedOf(catalogue: OnDemandCatalogue, kind: TitleKind): readonly Named[] {
  let kept = namedRows.get(catalogue);
  if (!kept) namedRows.set(catalogue, (kept = {}));
  return (kept[kind] ??= (() => {
    const [categories, raw] =
      kind === "movie"
        ? [catalogue.movieCategories, catalogue.movies]
        : [catalogue.seriesCategories, catalogue.series];
    // The adult flag is a standard field; a category named for adults also counts.
    const isAdult = adultIn(categories);
    const seen = new Set<string>();
    return raw.flatMap((item, listedOrder): Named[] => {
      if (seen.has(item.id)) return [];
      seen.add(item.id);
      return [
        { item, listedOrder, name: titleName(item.name, item.releaseDate), adult: isAdult(item) },
      ];
    });
  })());
}

function indexKind(
  kind: TitleKind,
  sources: readonly CatalogueSource[],
  language: string,
): IndexedKind {
  // One group per film: the versions sharing a TMDB id, of whichever subscription, or a row on
  // its own without one. A row for adults stays on its own, so the film's other versions don't
  // go with it.
  const groups: Listed[][] = [];
  const byTmdbId = new Map<string, Listed[]>();
  for (const { subscriptionId, catalogue } of sources) {
    for (const row of namedOf(catalogue, kind)) {
      const listed = { ...row, subscriptionId };
      const key = row.item.tmdbId && !row.adult ? row.item.tmdbId : null;
      const group = key ? byTmdbId.get(key) : undefined;
      if (group) {
        group.push(listed);
        continue;
      }
      const created = [listed];
      groups.push(created);
      if (key) byTmdbId.set(key, created);
    }
  }
  const titles: Title[] = [];
  /** Every version's name, title by title, for search. */
  const names: string[] = [];
  const byId = new Map<string, Title>();
  for (const group of groups) {
    const versions = group.map((listed): Version => ({
      ...listed,
      // With one version there is nothing to choose between.
      fit: group.length === 1 ? 1 : suitability(listed.name.tags, language),
    }));
    // The version suiting the language best first, then the newest; equals keep the order of
    // the subscriptions.
    if (versions.length > 1) {
      versions.sort((a, b) => b.fit - a.fit || (b.item.addedAt ?? 0) - (a.item.addedAt ?? 0));
    }
    const first = versions[0] as Version;
    // What the first version lacks, another may have; one pass, as most films have one version.
    let year = first.name.year;
    let posterUrl = first.item.posterUrl;
    let backdropUrl = first.item.backdropUrl;
    let rating = 0;
    // New when a version the viewer would watch arrived, not a dub into another language.
    let addedAt = 0;
    let anyAddedAt = 0;
    for (const { item, name, fit } of versions) {
      year ??= name.year;
      posterUrl ??= item.posterUrl;
      backdropUrl ??= item.backdropUrl;
      rating = Math.max(rating, item.rating ?? 0);
      if (fit > 0) addedAt = Math.max(addedAt, item.addedAt ?? 0);
      anyAddedAt = Math.max(anyAddedAt, item.addedAt ?? 0);
    }
    const shown = { subscriptionId: first.subscriptionId, id: first.item.id };
    const tmdbId = first.item.tmdbId ?? null;
    const title: Title = {
      kind,
      // The TMDB id names it wherever versions gather under one, whichever shows first.
      key: tmdbId && !first.adult ? `${kind}:tmdb:${tmdbId}` : `${kind}:${ownedKey(shown)}`,
      ...shown,
      name: first.item.name,
      title: first.name.title,
      originalTitle: null,
      originalLanguage: null,
      tags: first.name.tags,
      year,
      posterUrl,
      backdropUrl,
      rating: rating || null,
      addedAt: addedAt || anyAddedAt || null,
      adult: versions.length === 1 && first.adult,
      tmdbId,
      genres: [],
      versions: versions.map(({ subscriptionId, item, name, listedOrder }) => ({
        subscriptionId,
        id: item.id,
        tags: name.tags,
        name: item.name,
        container: item.container,
        addedAt: item.addedAt,
        listedOrder,
        ...(item.episodeFiles ? { episodeFiles: item.episodeFiles } : {}),
      })),
    };
    titles.push(title);
    names.push(
      versions.length === 1 ? first.item.name : group.map(({ item }) => item.name).join(" "),
    );
  }
  const shown = sources.length > 1 ? marked(titles) : titles;
  for (const title of shown) {
    for (const version of title.versions) byId.set(ownedKey(version), title);
  }
  return {
    titles: shown,
    byId,
    byTmdbId: once(
      () =>
        new Map(
          shown.flatMap((title) =>
            title.tmdbId && !title.adult ? [[title.tmdbId, title] as const] : [],
          ),
        ),
    ),
    searchNames: once(() =>
      shown.map((title, index) => normalize(`${title.title} ${names[index] ?? ""}`)),
    ),
  };
}

/**
 * The titles, with those marked `ambiguous` that show under the same name and year as a title of
 * another subscription without being it: nothing else would tell the two tiles apart. A title
 * with versions of several subscriptions needs no mark, and titles for adults are told apart
 * among themselves.
 */
function marked(titles: readonly Title[]): readonly Title[] {
  /** Which subscription lists what shows as this, or null once a second one does. */
  const listedBy = new Map<string, string | null>();
  const reads = (title: Title) =>
    `${title.adult}\n${title.year ?? ""}\n${title.title.toLowerCase()}`;
  for (const title of titles) {
    const key = reads(title);
    for (const { subscriptionId } of title.versions) {
      const owner = listedBy.get(key);
      if (owner === undefined) listedBy.set(key, subscriptionId);
      else if (owner !== subscriptionId) listedBy.set(key, null);
    }
  }
  return titles.map((title) => {
    const { subscriptionId } = title;
    const own = title.versions.every((version) => version.subscriptionId === subscriptionId);
    return own && listedBy.get(reads(title)) === null ? { ...title, ambiguous: true } : title;
  });
}

export function kindOf(catalogue: IndexedCatalogue, kind: TitleKind): IndexedKind {
  return kind === "movie" ? catalogue.movies : catalogue.series;
}

/** Titles by any of their versions, in the order asked, skipping those the catalogue doesn't have. */
export function byIds(
  catalogue: IndexedCatalogue,
  kind: TitleKind,
  versions: readonly OwnedId[],
): Title[] {
  const { byId } = kindOf(catalogue, kind);
  return versions.flatMap((version) => byId.get(ownedKey(version)) ?? []);
}

/**
 * Titles whose name holds every word of the query: the shown name, the provider's names of every
 * version, and `aliases`, other names already folded, such as TMDB's translations. Names that
 * start with it rank first, then names with a word starting with it; ties go to the newest, and
 * equals to the order of the catalogue. Titles for adults are left out.
 */
export function search(
  catalogue: IndexedCatalogue,
  kind: TitleKind,
  query: string,
  aliases: (title: Title) => string = () => "",
  limit = SEARCH_LIMIT,
): Title[] {
  return searchPage(catalogue, kind, query, aliases, limit).titles;
}

/** What `search` finds, with how many titles match in all, though only the best `limit` come back. */
export function searchPage(
  catalogue: IndexedCatalogue,
  kind: TitleKind,
  query: string,
  aliases: (title: Title) => string = () => "",
  limit = SEARCH_LIMIT,
): { readonly titles: Title[]; readonly total: number } {
  const folded = normalize(query);
  if (!folded) return { titles: [], total: 0 };
  const words = folded.split(" ");
  const indexed = kindOf(catalogue, kind);
  const { titles } = indexed;
  const searchNames = indexed.searchNames();
  // Only the best `limit` are kept: when twice that many wait, the worst half goes, and a match
  // that doesn't beat the worst kept is never held. The scan is in catalogue order and sorts are
  // stable, so equals stay in that order, as one sort of every match would leave them.
  const ranked: Ranked[] = [];
  let worst: Ranked | undefined;
  let total = 0;
  for (const [index, title] of titles.entries()) {
    if (title.adult) continue;
    const alias = aliases(title);
    const name = alias ? `${alias} ${searchNames[index] ?? ""}` : (searchNames[index] ?? "");
    if (!words.every((word) => name.includes(word))) continue;
    total++;
    const rank = name.startsWith(folded) ? 0 : ` ${name}`.includes(` ${folded}`) ? 1 : 2;
    const entry = { title, rank };
    if (worst && compareRanked(entry, worst) >= 0) continue;
    ranked.push(entry);
    if (ranked.length >= 2 * limit) {
      ranked.sort(compareRanked);
      ranked.length = limit;
      worst = ranked[limit - 1];
    }
  }
  ranked.sort(compareRanked);
  return { titles: ranked.slice(0, limit).map((entry) => entry.title), total };
}

interface Ranked {
  readonly title: Title;
  readonly rank: number;
}

function compareRanked(a: Ranked, b: Ranked): number {
  return a.rank - b.rank || (b.title.addedAt ?? 0) - (a.title.addedAt ?? 0);
}

/** A row with the subscription that lists it. */
interface Listed extends Named {
  readonly subscriptionId: string;
}

interface Version extends Listed {
  /** How well it suits the viewer's language: `suitability`. */
  readonly fit: number;
}

function once<A>(make: () => A): () => A {
  let value: { readonly made: A } | null = null;
  return () => (value ??= { made: make() }).made;
}
