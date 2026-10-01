// The collections Movies and Series show in their tabs, built from what every Xtream Codes
// provider sends (dates, ratings, names) and from TMDB's metadata (genres, languages,
// popularity, streaming services). Nothing here reads a provider's own category names.
import type {
  CollectionId,
  CollectionSort,
  Title,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import { GENRES, type TitleMetadata } from "../metadata/tmdb.ts";
import { suitability } from "./languages.ts";

/** A streaming service and the TMDB ids of what it streams in the viewer's region. */
export interface ServiceTitles {
  readonly id: number;
  readonly name: string;
  readonly ids: ReadonlySet<string>;
}

/** What collections need: the titles, and TMDB's metadata as far as it has arrived. */
export interface CollectionSource {
  readonly kind: TitleKind;
  readonly titles: readonly Title[];
  readonly language: string;
  readonly metadata: (tmdbId: string) => TitleMetadata | null;
  readonly services: readonly ServiceTitles[];
  /** Epoch milliseconds, for "this week". */
  readonly now: number;
}

/** A title with what collections sort and filter it by. */
interface Ranked {
  readonly title: Title;
  readonly genres: readonly string[];
  readonly popularity: number;
  /** TMDB's rating when enough people voted, else the provider's. */
  readonly rating: number;
  /** In the viewer's language or several; or, when nothing says how it sounds, not made in another. */
  readonly suits: boolean;
}

/** Votes TMDB needs before its rating counts. */
const ENOUGH_VOTES = 100;
/** Top rated: at least this, out of 10. */
const TOP_RATING = 7.5;
const DAY_MS = 24 * 60 * 60_000;
const IMAGES = "https://image.tmdb.org/t/p/w1280";

export interface Collections {
  /** A collection's titles, in `sort` or the collection's own order. */
  list(id: CollectionId, sort?: CollectionSort): readonly Title[];
  /** A collection's name to show: "Comedy", "Netflix", "New this week". */
  name(id: CollectionId): string | null;
  /** Genres with how many titles each, most first. */
  genres(): readonly {
    readonly name: string;
    readonly count: number;
    readonly artwork: string | null;
  }[];
  /** Streaming services with what of theirs the catalogue has, most first. */
  services(): readonly {
    readonly id: number;
    readonly name: string;
    readonly count: number;
    readonly artwork: string | null;
  }[];
}

export function collections(source: CollectionSource): Collections {
  const ranked = source.titles
    .filter((title) => !title.adult)
    .map((title): Ranked => {
      const meta = title.tmdbId ? source.metadata(title.tmdbId) : null;
      const shown: Title = meta
        ? {
            ...title,
            backdropUrl: title.backdropUrl ?? (meta.backdrop ? `${IMAGES}${meta.backdrop}` : null),
            genres: genresOf(meta),
          }
        : title;
      const fit = suitability(title.tags, source.language);
      return {
        title: shown,
        genres: shown.genres,
        popularity: meta?.popularity ?? 0,
        rating: meta && meta.votes >= ENOUGH_VOTES ? meta.rating : (title.rating ?? 0),
        suits: fit >= 2 || (fit === 1 && (!meta?.language || meta.language === source.language)),
      };
    });
  const suiting = ranked.filter((entry) => entry.suits);
  const lists = new Map<string, readonly Title[]>();

  const orders: Record<CollectionSort, (a: Ranked, b: Ranked) => number> = {
    added: (a, b) => (b.title.addedAt ?? 0) - (a.title.addedAt ?? 0),
    popular: (a, b) =>
      b.popularity - a.popularity || (b.title.addedAt ?? 0) - (a.title.addedAt ?? 0),
    rating: (a, b) => b.rating - a.rating || b.popularity - a.popularity,
    title: (a, b) => collator.compare(a.title.title, b.title.title),
  };

  /** A collection's members and the order it shows them in unless asked otherwise. */
  function members(id: CollectionId): { entries: readonly Ranked[]; order: CollectionSort } {
    if (id === "all") return { entries: ranked, order: "added" };
    if (id === "new-week") {
      return {
        entries: suiting.filter((entry) => added(entry) > source.now - 7 * DAY_MS),
        order: "added",
      };
    }
    if (id === "new-month") {
      return {
        entries: suiting.filter((entry) => added(entry) > source.now - 30 * DAY_MS),
        order: "added",
      };
    }
    if (id === "recent") {
      const year = new Date(source.now).getUTCFullYear();
      return {
        entries: suiting.filter((entry) => (entry.title.year ?? 0) >= year - 1),
        order: "popular",
      };
    }
    if (id === "popular")
      return { entries: suiting.filter((entry) => entry.popularity > 0), order: "popular" };
    if (id === "top-rated")
      return { entries: suiting.filter((entry) => entry.rating >= TOP_RATING), order: "rating" };
    if (id === "4k") {
      return {
        entries: suiting.filter((entry) =>
          entry.title.versions.some((version) =>
            version.tags.some((tag) => tag === "4K" || tag === "UHD"),
          ),
        ),
        order: "added",
      };
    }
    if (id.startsWith("genre:")) {
      const genre = id.slice("genre:".length);
      return { entries: suiting.filter((entry) => entry.genres.includes(genre)), order: "popular" };
    }
    if (id.startsWith("service:")) {
      const service = source.services.find((each) => `service:${each.id}` === id);
      if (!service) return { entries: [], order: "popular" };
      return {
        entries: suiting.filter(
          (entry) => entry.title.tmdbId && service.ids.has(entry.title.tmdbId),
        ),
        order: "popular",
      };
    }
    if (id.startsWith("like:"))
      return { entries: alike(id.slice("like:".length)), order: "popular" };
    return { entries: [], order: "added" };
  }

  /** Titles sharing the most genres with one, more popular first; the title itself left out. */
  function alike(titleId: string): Ranked[] {
    const seed = ranked.find((entry) =>
      entry.title.versions.some((version) => version.id === titleId),
    );
    if (!seed || seed.genres.length === 0) return [];
    const scored = suiting.flatMap((entry) => {
      if (entry === seed) return [];
      const shared = entry.genres.filter((genre) => seed.genres.includes(genre)).length;
      return shared > 0 ? [{ entry, shared }] : [];
    });
    scored.sort((a, b) => b.shared - a.shared || b.entry.popularity - a.entry.popularity);
    return scored.map(({ entry }) => entry);
  }

  return {
    list(id, sort) {
      const { entries, order } = members(id);
      const key = `${id}|${sort ?? order}`;
      let list = lists.get(key);
      if (!list) {
        list = entries.toSorted(orders[sort ?? order]).map((entry) => entry.title);
        lists.set(key, list);
      }
      return list;
    },

    name(id) {
      if (id.startsWith("genre:")) return id.slice("genre:".length);
      if (id.startsWith("service:")) {
        return source.services.find((service) => `service:${service.id}` === id)?.name ?? null;
      }
      if (id.startsWith("like:")) {
        const seed = ranked.find((entry) =>
          entry.title.versions.some((version) => version.id === id.slice(5)),
        );
        return seed ? `More like ${seed.title.title}` : null;
      }
      return NAMES[id as keyof typeof NAMES] ?? null;
    },

    genres() {
      const byGenre = new Map<string, Ranked[]>();
      for (const entry of suiting) {
        for (const genre of entry.genres) {
          const list = byGenre.get(genre);
          if (list) list.push(entry);
          else byGenre.set(genre, [entry]);
        }
      }
      return [...byGenre]
        .map(([name, entries]) => ({ name, count: entries.length, artwork: artworkOf(entries) }))
        .sort((a, b) => b.count - a.count);
    },

    services() {
      return source.services
        .map((service) => {
          const entries = suiting.filter(
            (entry) => entry.title.tmdbId && service.ids.has(entry.title.tmdbId),
          );
          return {
            id: service.id,
            name: service.name,
            count: entries.length,
            artwork: artworkOf(entries),
          };
        })
        .filter((service) => service.count > 0)
        .sort((a, b) => b.count - a.count);
    },
  };
}

const NAMES = {
  all: "All",
  "new-week": "New this week",
  "new-month": "New this month",
  recent: "Recent releases",
  popular: "Popular",
  "top-rated": "Top rated",
  "4k": "4K",
} as const;

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function added(entry: Ranked): number {
  return entry.title.addedAt ?? 0;
}

/** Genre names, once each, in TMDB's order. */
function genresOf(meta: TitleMetadata): string[] {
  return [...new Set(meta.genres.flatMap((id) => GENRES[id] ?? []))];
}

/** A landscape picture for a tile: the most popular member's that has one. */
function artworkOf(entries: readonly Ranked[]): string | null {
  let best: Ranked | null = null;
  for (const entry of entries) {
    if (entry.title.backdropUrl && (!best || entry.popularity > best.popularity)) best = entry;
  }
  return best?.title.backdropUrl ?? null;
}
