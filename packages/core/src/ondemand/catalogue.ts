// The movie and series catalogue as plain data and functions: indexing what the provider sent and
// answering the lists, pages and searches the UI asks for. Display names are worked out here, on
// load, so naming rules improve without fetching again.
import type {
  Title,
  TitleCategory,
  TitleKind,
  TitlePage,
  TitleSort,
} from "@mrstreamer/contracts/ondemand";
import { normalizeCatalogue } from "../catalogue/normalize.ts";
import type { OnDemandCatalogue, ProviderCategory, ProviderTitle } from "../provider.ts";
import { normalize } from "../text.ts";
import { titleName } from "./names.ts";

/** How many titles of each kind a search returns. */
export const SEARCH_LIMIT = 60;

/** Category names that say the category is for adults: "XXX | FOR ADULTS", "ADULT 18+". */
const ADULT_CATEGORY = /(?<![\p{L}\p{N}])(xxx|adults?|18\+|porn)(?![\p{L}\p{N}])/iu;

interface IndexedKind {
  readonly titles: readonly Title[];
  readonly byId: ReadonlyMap<string, Title>;
  /** The file type each movie streams as. */
  readonly containers: ReadonlyMap<string, string>;
  readonly categories: readonly TitleCategory[];
  readonly byCategory: ReadonlyMap<string, readonly Title[]>;
  /** Folded names, index-aligned with `titles`, worked out on the first search. */
  readonly searchNames: () => readonly string[];
  /** Lists already sorted, by category (or "" for all) and order. */
  readonly sorted: Map<string, readonly Title[]>;
}

export interface IndexedCatalogue {
  readonly movies: IndexedKind;
  readonly series: IndexedKind;
}

export function indexCatalogue(catalogue: OnDemandCatalogue): IndexedCatalogue {
  return {
    movies: indexKind("movie", catalogue.movieCategories, catalogue.movies),
    series: indexKind("series", catalogue.seriesCategories, catalogue.series),
  };
}

function indexKind(
  kind: TitleKind,
  rawCategories: readonly ProviderCategory[],
  raw: readonly ProviderTitle[],
): IndexedKind {
  const shown = normalizeCatalogue({ categories: rawCategories, channels: [] }).categories;
  const adultCategories = new Set(
    rawCategories.filter((category) => ADULT_CATEGORY.test(category.name)).map(({ id }) => id),
  );
  const titles: Title[] = [];
  const byId = new Map<string, Title>();
  const containers = new Map<string, string>();
  const byCategory = new Map<string, Title[]>();
  for (const item of raw) {
    if (byId.has(item.id)) continue;
    const name = titleName(item.name, item.releaseDate);
    const title: Title = {
      kind,
      id: item.id,
      name: item.name,
      title: name.title,
      tags: name.tags,
      year: name.year,
      posterUrl: item.posterUrl,
      backdropUrl: item.backdropUrl,
      rating: item.rating,
      addedAt: item.addedAt,
      categoryIds: item.categoryIds,
      adult: item.adult || item.categoryIds.some((id) => adultCategories.has(id)),
    };
    titles.push(title);
    byId.set(title.id, title);
    if (item.container) containers.set(item.id, item.container);
    for (const categoryId of item.categoryIds) {
      const list = byCategory.get(categoryId);
      if (list) list.push(title);
      else byCategory.set(categoryId, [title]);
    }
  }
  const categories = shown.flatMap((category): TitleCategory[] => {
    const members = byCategory.get(category.id) ?? [];
    if (members.length === 0) return [];
    const adult =
      adultCategories.has(category.id) ||
      members.filter((title) => title.adult).length > members.length / 2;
    return [{ ...category, count: members.length, adult }];
  });
  return {
    titles,
    byId,
    containers,
    categories,
    byCategory,
    searchNames: once(() => titles.map((title) => normalize(`${title.title} ${title.name}`))),
    sorted: new Map(),
  };
}

export function kindOf(catalogue: IndexedCatalogue, kind: TitleKind): IndexedKind {
  return kind === "movie" ? catalogue.movies : catalogue.series;
}

export interface PageQuery {
  readonly kind: TitleKind;
  /** A category, or every title of the kind. */
  readonly categoryId?: string | undefined;
  readonly sort: TitleSort;
  readonly offset: number;
  readonly limit: number;
}

/**
 * One page of a list. Titles for adults show only inside a category the viewer opened, never in
 * the lists of every title.
 */
export function page(catalogue: IndexedCatalogue, query: PageQuery): TitlePage {
  const indexed = kindOf(catalogue, query.kind);
  const cacheKey = `${query.categoryId ?? ""}|${query.sort}`;
  let list = indexed.sorted.get(cacheKey);
  if (!list) {
    const members =
      query.categoryId === undefined
        ? indexed.titles.filter((title) => !title.adult)
        : (indexed.byCategory.get(query.categoryId) ?? []);
    list = members.toSorted(ORDERS[query.sort]);
    indexed.sorted.set(cacheKey, list);
  }
  return { total: list.length, titles: list.slice(query.offset, query.offset + query.limit) };
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
  ranked.sort((a, b) => a.rank - b.rank || ORDERS.added(a.title, b.title));
  return ranked.slice(0, limit).map((entry) => entry.title);
}

function once<A>(make: () => A): () => A {
  let value: { readonly made: A } | null = null;
  return () => (value ??= { made: make() }).made;
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const byName = (a: Title, b: Title) => collator.compare(a.title, b.title);

const ORDERS: Record<TitleSort, (a: Title, b: Title) => number> = {
  added: (a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) || byName(a, b),
  title: byName,
  rating: (a, b) => (b.rating ?? 0) - (a.rating ?? 0) || byName(a, b),
};
