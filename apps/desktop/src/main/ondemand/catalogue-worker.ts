// The movie and series catalogue, in a worker thread. Its lists run to tens of megabytes, and
// reading, indexing and sorting them would hold the main process for hundreds of milliseconds;
// here that costs nothing the viewer notices. The main process sends small calls and gets pages.
//
// The catalogue on disk (ondemand.json.gz) keeps the provider's lists as they came, for one
// account; display names are worked out on load. In memory it is one subscription's, and every
// title and version made from it says so.
//
// A refresh takes two calls. The lists it fetches wait aside until the main process, which knows
// the saved login, says whether they still count: only then do they show and reach the disk.
import { workerData, parentPort } from "node:worker_threads";
import { type } from "arktype";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import {
  byIds,
  indexCatalogue,
  kindOf,
  search,
  type IndexedCatalogue,
} from "@mrstreamer/core/ondemand/catalogue";
import type { CollectionId, Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { adultIn } from "@mrstreamer/core/adult";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import { tmdb, tmdbImage } from "@mrstreamer/core/metadata/tmdb";
import { collections, type Collections } from "@mrstreamer/core/ondemand/collections";
import { readJsonFile, removeFile, writeJsonFile } from "../platform/json-file.ts";
import { providerFor } from "../providers/account.ts";
import { metadataStore, type Wanted } from "./metadata.ts";
import type {
  CatalogueOwner,
  WorkerCalls,
  WorkerEvent,
  WorkerRequest,
  WorkerSetup,
  WorkerStatus,
} from "./protocol.ts";

const setup = workerData as WorkerSetup;

/** Counts arrivals of metadata, so collections built before them are built again. */
let metadataVersion = 0;
/** The viewer's language as the last call named it: TMDB's names are asked for in it. */
let viewerLanguage = "en";

/** TMDB's metadata, kept across subscriptions: it describes titles, not accounts. */
const metadata = metadataStore({
  path: setup.metadataPath,
  client: setup.tmdb
    ? tmdb({ key: setup.tmdb.key, ...(setup.tmdb.api ? { api: setup.tmdb.api } : {}) })
    : null,
  region: setup.tmdb?.region ?? "US",
  onChange: () => {
    metadataVersion++;
    parentPort?.postMessage({ event: "metadata", status: metadata.status() } satisfies WorkerEvent);
  },
});

/**
 * Whether the viewer shows titles for adults, as the main process says with each status call:
 * TMDB is asked about them only then.
 */
let adults = false;

/**
 * Every TMDB id the catalogue lists, once, with when it was added. Titles for adults count only
 * while the viewer shows them.
 */
function wantedOf(catalogue: OnDemandCatalogue): Wanted[] {
  const found = new Map<string, Wanted>();
  for (const [kind, titles, categories] of [
    ["movie", catalogue.movies, catalogue.movieCategories],
    ["tv", catalogue.series, catalogue.seriesCategories],
  ] as const) {
    const isAdult = adultIn(categories);
    for (const title of titles) {
      if (!title.tmdbId || (!adults && isAdult(title))) continue;
      const key = `${kind}:${title.tmdbId}`;
      const addedAt = title.addedAt ?? 0;
      if ((found.get(key)?.addedAt ?? -1) < addedAt) {
        found.set(key, { kind, tmdbId: title.tmdbId, addedAt });
      }
    }
  }
  return [...found.values()];
}

const Category = type({ id: "string", name: "string" });
const ProviderTitle = type({
  id: "string",
  name: "string",
  posterUrl: "string | null",
  backdropUrl: "string | null",
  rating: "number | null",
  addedAt: "number | null",
  releaseDate: "string | null",
  categoryIds: "string[]",
  adult: "boolean",
  container: "string | null",
  "tmdbId?": "string | null",
});
/** Version 1 came before TMDB ids: still shown, but refreshed as soon as the app can. */
const CachedCatalogue = type({
  version: "1 | 2",
  /** Which subscription produced it. */
  key: "string",
  fetchedAt: "number",
  movieCategories: Category.array(),
  movies: ProviderTitle.array(),
  seriesCategories: Category.array(),
  series: ProviderTitle.array(),
});

interface Loaded {
  /** The subscription whose titles these are. */
  readonly subscriptionId: string;
  readonly fetchedAt: number;
  readonly catalogue: OnDemandCatalogue;
  readonly movies: number;
  readonly series: number;
  /** Built on first use, and again when the viewer's language changes. */
  index: IndexedCatalogue | null;
  /** By language, kind and metadata version; built when first asked for. */
  readonly collections: Map<string, Collections>;
}

let loaded: Loaded | null = null;
/** The refresh in flight, shared by calls for the same subscription with the same login. */
let refreshing: {
  readonly subscriptionId: string;
  readonly revision: number;
  readonly done: Promise<null>;
  readonly abort: AbortController;
} | null = null;
/**
 * The lists the last refresh fetched, set aside until the main process says whether the login
 * they were asked under still stands.
 */
let fetched: {
  readonly subscriptionId: string;
  readonly revision: number;
  readonly catalogue: OnDemandCatalogue;
} | null = null;

function remember(subscriptionId: string, fetchedAt: number, catalogue: OnDemandCatalogue): Loaded {
  loaded = {
    subscriptionId,
    fetchedAt,
    catalogue,
    movies: catalogue.movies.length,
    series: catalogue.series.length,
    index: null,
    collections: new Map(),
  };
  // After the call that loaded it has answered, unless another catalogue took its place.
  setTimeout(() => {
    if (loaded?.catalogue === catalogue) metadata.want(wantedOf(catalogue), viewerLanguage);
  }, 0);
  return loaded;
}

/** The collections of a kind as a viewer of `language` sees them, with the metadata so far. */
function collectionsOf(found: Loaded, language: string, kind: TitleKind): Collections {
  const key = `${language}|${kind}|${metadataVersion}`;
  let made = found.collections.get(key);
  if (!made) {
    const tmdbKind = kind === "movie" ? "movie" : "tv";
    made = collections({
      kind,
      titles: kindOf(indexOf(found, language), kind).titles,
      language,
      metadata: (tmdbId) => metadata.get(tmdbKind, tmdbId),
      names: (tmdbId) => metadata.name(tmdbKind, tmdbId, language),
      services: metadata.services(tmdbKind),
      now: Date.now(),
    });
    // Other languages and older metadata only take memory.
    for (const old of found.collections.keys()) {
      if (old.startsWith(`${language}|`) && old.endsWith(`|${metadataVersion}`)) continue;
      found.collections.delete(old);
    }
    found.collections.set(key, made);
  }
  return made;
}

/** How many titles a row shows before its All. */
const ROW_TITLES = 24;
/** Streaming services For you shows as rows, most stocked first. */
const SERVICE_ROWS = 3;

/** Notes whether the viewer shows titles for adults; turning it on asks TMDB about them. */
function showing(shown: boolean): void {
  if (shown === adults) return;
  adults = shown;
  if (loaded) metadata.want(wantedOf(loaded.catalogue), viewerLanguage);
}

/**
 * Notes the viewer's language from a call; a new one asks TMDB for names in it, in the
 * background.
 */
function speaking(language: string): void {
  if (language === viewerLanguage) return;
  viewerLanguage = language;
  if (loaded) metadata.want(wantedOf(loaded.catalogue), language);
}

/**
 * A title with TMDB's name for a viewer of `language`, the language it was made in and its
 * backdrop, once known, as collections show it.
 */
function named(title: Title, language: string): Title {
  if (!title.tmdbId) return title;
  const kind = title.kind === "movie" ? "movie" : "tv";
  const found = metadata.name(kind, title.tmdbId, language);
  const known = metadata.get(kind, title.tmdbId);
  const backdrop = title.backdropUrl ? null : known?.backdrop;
  return {
    ...title,
    ...(found ? { title: found.name, originalTitle: found.original } : {}),
    originalLanguage: known?.language ?? null,
    ...(backdrop ? { backdropUrl: tmdbImage(backdrop, 1280) } : {}),
  };
}

/** The catalogue as a viewer of `language` sees it. */
function indexOf(found: Loaded, language: string): IndexedCatalogue {
  if (found.index?.language !== language) {
    found.index = indexCatalogue(found.catalogue, language, found.subscriptionId);
  }
  return found.index;
}

/** The cache being written. Writes go one at a time, and clearing waits for them. */
let writing: Promise<void> = Promise.resolve();
/**
 * How long a write waits. Turning the lists into JSON holds this thread for a quarter of a
 * second, and the pages the UI asks for right after a refresh come first.
 */
const WRITE_AFTER_MS = 1000;

/** The cache from before it was packed, read once and removed after the next write. */
const legacyCachePath = setup.cachePath.replace(/\.gz$/, "");

function persist(file: object): void {
  writing = writing
    .then(() => new Promise((done) => setTimeout(done, WRITE_AFTER_MS)))
    .then(() => writeJsonFile(setup.cachePath, file))
    .then(() => removeFile(legacyCachePath))
    .catch(() => {});
}

/** Lists that came back empty once, by subscription: a second time in a row, they count. */
const emptyBefore = new Set<string>();

/** The cache file being read, so the calls a start sends together read it once. */
let reading: {
  readonly subscriptionId: string;
  readonly done: Promise<Loaded | null>;
} | null = null;

/**
 * The subscription's catalogue from memory, or from disk when the lists there are its account's,
 * or null when there is none yet.
 */
function current({ subscriptionId, key }: CatalogueOwner): Promise<Loaded | null> {
  if (loaded?.subscriptionId === subscriptionId) return Promise.resolve(loaded);
  if (reading?.subscriptionId === subscriptionId) return reading.done;
  const done = (async () => {
    const file =
      (await readJsonFile(setup.cachePath, CachedCatalogue)) ??
      (legacyCachePath === setup.cachePath
        ? null
        : await readJsonFile(legacyCachePath, CachedCatalogue));
    // Cleared while reading, when the account went.
    if (file?.key !== key || reading?.subscriptionId !== subscriptionId) return null;
    if (loaded?.subscriptionId === subscriptionId) return loaded;
    return remember(subscriptionId, file.version === 2 ? file.fetchedAt : 0, file);
  })();
  reading = { subscriptionId, done };
  const settled = () => {
    if (reading?.done === done) reading = null;
  };
  done.then(settled, settled);
  return done;
}

/** The subscription's catalogue, or the failure the UI explains when nothing is loaded yet. */
async function required(owner: CatalogueOwner): Promise<Loaded> {
  const found = await current(owner);
  if (found) return found;
  throw new AppFailure({ kind: "unexpected", detail: "Movies and series haven't loaded yet." });
}

function statusOf(found: Loaded | null): WorkerStatus {
  return {
    movies: found?.movies ?? 0,
    series: found?.series ?? 0,
    fetchedAt: found?.fetchedAt ?? null,
  };
}

async function refresh(args: WorkerCalls["refresh"]["args"]): Promise<null> {
  const { subscriptionId, revision } = args;
  if (refreshing?.subscriptionId === subscriptionId && refreshing.revision === revision) {
    return refreshing.done;
  }
  // Another subscription's, or this one's under the login it had before.
  refreshing?.abort.abort();
  const abort = new AbortController();
  const done = (async () => {
    const provider = providerFor(args.account, { userAgent: setup.userAgent });
    const catalogue = await provider.onDemandCatalogue(abort.signal);
    const before = await current(args);
    // An empty list doesn't replace one that had titles, unless it comes twice in a row, as for
    // channels: panels answer an overloaded request with an empty list, and one list can fail
    // while the other arrives.
    for (const list of ["movies", "series"] as const) {
      const mark = `${subscriptionId}:${list}`;
      const lost = catalogue[list].length === 0 && (before?.[list] ?? 0) > 0;
      if (!lost || emptyBefore.has(mark)) {
        emptyBefore.delete(mark);
        continue;
      }
      emptyBefore.add(mark);
      throw new AppFailure({
        kind: "incomplete-catalogue",
        received: 0,
        previous: before?.[list] ?? 0,
        list,
      });
    }
    if (abort.signal.aborted) throw new AppFailure({ kind: "unexpected", detail: "Stopped." });
    // A category list that comes back empty keeps the one before: panels answer an overloaded
    // request with an empty list too, and without its names, titles only a category marks for
    // adults would show everywhere.
    const kept: OnDemandCatalogue = {
      ...catalogue,
      movieCategories:
        catalogue.movieCategories.length > 0 || !before
          ? catalogue.movieCategories
          : before.catalogue.movieCategories,
      seriesCategories:
        catalogue.seriesCategories.length > 0 || !before
          ? catalogue.seriesCategories
          : before.catalogue.seriesCategories,
    };
    fetched = { subscriptionId, revision, catalogue: kept };
    return null;
  })();
  const running = { subscriptionId, revision, done, abort };
  refreshing = running;
  try {
    return await done;
  } finally {
    if (refreshing === running) refreshing = null;
  }
}

/**
 * Ends a refresh as the main process decided: the lists set aside for it become the
 * subscription's and are saved, or are dropped. Answers the status that leaves.
 */
async function finishRefresh({
  revision,
  keep,
  ...owner
}: WorkerCalls["finishRefresh"]["args"]): Promise<WorkerStatus> {
  const { subscriptionId } = owner;
  const aside = fetched;
  // Gone already when a call that shared the refresh ended it, or the account went.
  if (aside?.subscriptionId !== subscriptionId || aside.revision !== revision) {
    return statusOf(await current(owner));
  }
  fetched = null;
  if (!keep) return statusOf(await current(owner));
  const fetchedAt = Date.now();
  const status = statusOf(remember(subscriptionId, fetchedAt, aside.catalogue));
  // Written after answering, so the lists show without waiting for the disk. A write cut short
  // by quitting leaves the previous lists for the next start, which refreshes them when due.
  persist({ version: 2, key: owner.key, fetchedAt, ...aside.catalogue });
  return status;
}

/** TMDB's names for a title, so search finds it by its translations and its original name too. */
function aliases(title: Title): string {
  return title.tmdbId
    ? metadata.searchName(title.kind === "movie" ? "movie" : "tv", title.tmdbId)
    : "";
}

const handlers: {
  [M in keyof WorkerCalls]: (args: WorkerCalls[M]["args"]) => Promise<WorkerCalls[M]["result"]>;
} = {
  status: async ({ adults: shown, ...owner }) => {
    showing(shown);
    return statusOf(await current(owner));
  },
  refresh,
  finishRefresh,
  byIds: async ({ language, kind, ids, ...owner }) => {
    speaking(language);
    const found = await current(owner);
    return found
      ? byIds(indexOf(found, language), kind, ids).map((title) => named(title, language))
      : [];
  },
  search: async ({ language, query, ...owner }) => {
    speaking(language);
    const found = await current(owner);
    if (!found) return { movies: [], series: [] };
    const index = indexOf(found, language);
    const matches = (kind: TitleKind) =>
      search(index, kind, query, aliases).map((title) => named(title, language));
    return { movies: matches("movie"), series: matches("series") };
  },
  searchKind: async ({ language, kind, query, limit, ...owner }) => {
    speaking(language);
    const found = await current(owner);
    if (!found) return { titles: [], total: 0 };
    const matches = search(indexOf(found, language), kind, query, aliases, Infinity);
    return {
      titles: matches.slice(0, limit).map((title) => named(title, language)),
      total: matches.length,
    };
  },
  rows: async ({ language, kind, tab, like, ...owner }) => {
    speaking(language);
    const made = collectionsOf(await required(owner), language, kind);
    const ids: CollectionId[] =
      tab === "new"
        ? ["new-week", "new-month", "recent"]
        : [
            ...(like ? [`like:${ownedKey(like)}` as const] : []),
            "popular",
            "new-week",
            "top-rated",
            ...made
              .services()
              .slice(0, SERVICE_ROWS)
              .map((service) => `service:${service.id}` as const),
          ];
    return ids.flatMap((id) => {
      const titles = made.list(id);
      const name = made.name(id);
      if (titles.length === 0 || !name) return [];
      return [{ id, name, total: titles.length, titles: titles.slice(0, ROW_TITLES) }];
    });
  },
  tiles: async ({ language, kind, of, ...owner }) => {
    speaking(language);
    const made = collectionsOf(await required(owner), language, kind);
    return of === "genres"
      ? made.genres().map((genre) => ({
          id: `genre:${genre.name}` as const,
          name: genre.name,
          count: genre.count,
          artworkUrl: genre.artwork,
        }))
      : made.services().map((service) => ({
          id: `service:${service.id}` as const,
          name: service.name,
          count: service.count,
          artworkUrl: service.artwork,
        }));
  },
  collection: async ({ language, kind, id, sort, offset, limit, ...owner }) => {
    speaking(language);
    const made = collectionsOf(await required(owner), language, kind);
    const titles = made.list(id, sort);
    return {
      name: made.name(id) ?? "",
      total: titles.length,
      titles: titles.slice(offset, offset + limit),
    };
  },
  container: async ({ id, ...owner }) => {
    const found = await current(owner);
    // Any language's index knows every version's file type.
    return found
      ? (found.catalogue.movies.find((movie) => movie.id === id)?.container ?? null)
      : null;
  },
  clear: async () => {
    refreshing?.abort.abort();
    refreshing = null;
    fetched = null;
    reading = null;
    loaded = null;
    emptyBefore.clear();
    // The account's titles aren't wanted any more.
    metadata.want([]);
    await writing;
    await Promise.all([removeFile(setup.cachePath), removeFile(legacyCachePath)]);
    return null;
  },
  flush: async () => {
    await Promise.all([writing, metadata.flush()]);
    return null;
  },
};

parentPort?.on("message", (request: WorkerRequest) => {
  const handler = handlers[request.method] as (args: unknown) => Promise<unknown>;
  handler(request.args).then(
    (value) => parentPort?.postMessage({ id: request.id, ok: true, value }),
    (cause: unknown) =>
      parentPort?.postMessage({ id: request.id, ok: false, error: errorOf(cause) }),
  );
});

function errorOf(cause: unknown): AppError {
  if (cause instanceof AppFailure) return cause.error;
  return { kind: "unexpected", detail: cause instanceof Error ? cause.message : String(cause) };
}
