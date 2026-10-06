// The movie and series catalogue, in a worker thread. Its lists run to tens of megabytes, and
// reading, indexing and sorting them would hold the main process for hundreds of milliseconds;
// here that costs nothing the viewer notices. The main process sends small calls and gets pages.
//
// Each subscription's lists are kept as its provider sent them, in memory and in its folder
// (ondemand.json.gz), and display names are worked out on load. What the lists show is made of
// all of them at once: one catalogue, in which a film two subscriptions list under one TMDB id is
// one title. It is sorted, searched and counted whole and cut into pages only then, so no
// subscription is cut short before another's titles are in, and a page never holds a film twice.
// One worker holds every subscription's lists; none gets a thread of its own.
//
// A refresh takes two calls. The lists it fetches wait aside until the main process, which knows
// the saved login, says whether they still count: only then do they show and reach the disk.
import { join } from "node:path";
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

/** One subscription's lists. */
interface Loaded {
  /** The subscription whose titles these are. */
  readonly subscriptionId: string;
  readonly fetchedAt: number;
  readonly catalogue: OnDemandCatalogue;
  readonly movies: number;
  readonly series: number;
}

/** Each subscription's lists, by its id, once read from disk or fetched. */
const loaded = new Map<string, Loaded>();
/** The refreshes in flight, by subscription, shared by calls with the same login. */
const refreshing = new Map<
  string,
  { readonly revision: number; readonly done: Promise<null>; readonly abort: AbortController }
>();
/**
 * The lists a refresh fetched, by subscription, set aside until the main process says whether the
 * login they were asked under still stands.
 */
const fetched = new Map<
  string,
  { readonly revision: number; readonly catalogue: OnDemandCatalogue }
>();

/** What the lists of some subscriptions make together, as a viewer of one language sees it. */
interface Shown {
  /** What it was made of: the same lists in the same order make the same catalogue. */
  readonly members: readonly Loaded[];
  readonly index: IndexedCatalogue;
  /** By kind and metadata version; built when first asked for. */
  readonly collections: Map<string, Collections>;
}

/** The catalogue last made: the one every page of a visit asks for. */
let shown: Shown | null = null;

/**
 * Every TMDB id the loaded lists hold, once, with when it was added. Titles for adults count only
 * while the viewer shows them.
 */
function wanted(): Wanted[] {
  const found = new Map<string, Wanted>();
  for (const { catalogue } of loaded.values()) {
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
  }
  return [...found.values()];
}

function remember(subscriptionId: string, fetchedAt: number, catalogue: OnDemandCatalogue): Loaded {
  const kept: Loaded = {
    subscriptionId,
    fetchedAt,
    catalogue,
    movies: catalogue.movies.length,
    series: catalogue.series.length,
  };
  loaded.set(subscriptionId, kept);
  // After the call that loaded it has answered, unless other lists took its place.
  setTimeout(() => {
    if (loaded.get(subscriptionId) === kept) metadata.want(wanted(), viewerLanguage);
  }, 0);
  return kept;
}

/** How many titles a row shows before its All. */
const ROW_TITLES = 24;
/** Streaming services For you shows as rows, most stocked first. */
const SERVICE_ROWS = 3;

/** Notes whether the viewer shows titles for adults; turning it on asks TMDB about them. */
function showing(now: boolean): void {
  if (now === adults) return;
  adults = now;
  if (loaded.size > 0) metadata.want(wanted(), viewerLanguage);
}

/**
 * Notes the viewer's language from a call; a new one asks TMDB for names in it, in the
 * background.
 */
function speaking(language: string): void {
  if (language === viewerLanguage) return;
  viewerLanguage = language;
  if (loaded.size > 0) metadata.want(wanted(), language);
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

const cachePath = (owner: CatalogueOwner) => join(owner.dir, "ondemand.json.gz");
/** The cache from before it was packed, read once and removed after the next write. */
const legacyCachePath = (owner: CatalogueOwner) => join(owner.dir, "ondemand.json");

/** The lists still to be written, by subscription: the newest of each. */
const unsaved = new Map<string, { readonly owner: CatalogueOwner; readonly kept: Loaded }>();
/** The wait before those are written; null while none wait. */
let waiting: NodeJS.Timeout | null = null;
/** The caches being written. Writes go one at a time, and forgetting lists waits for them. */
let writing: Promise<void> = Promise.resolve();
/**
 * How long lists wait to be written. Turning them into JSON holds this thread for a quarter of a
 * second, and the pages the UI asks for right after a refresh come first. The wait is one for
 * every subscription's lists, from the last that arrived, and stopping the worker skips it: a
 * wait each, one after another, would outlast the moment a quit gives.
 */
const WRITE_AFTER_MS = 1000;

/** Has a subscription's lists saved once the wait is over. */
function persist(owner: CatalogueOwner, kept: Loaded): void {
  unsaved.set(owner.subscriptionId, { owner, kept });
  if (waiting) clearTimeout(waiting);
  waiting = setTimeout(() => void save(), WRITE_AFTER_MS);
}

/**
 * Writes the lists that wait, now, one subscription after another, and is done once they and
 * any write before them are on disk. Lists that newer ones replaced, or whose subscription went
 * meanwhile, aren't written.
 */
function save(): Promise<void> {
  if (waiting) clearTimeout(waiting);
  waiting = null;
  for (const { owner, kept } of unsaved.values()) {
    writing = writing
      .then(async () => {
        if (loaded.get(owner.subscriptionId) !== kept) return;
        const { fetchedAt, catalogue } = kept;
        await writeJsonFile(cachePath(owner), {
          version: 2,
          key: owner.key,
          fetchedAt,
          ...catalogue,
        });
        await removeFile(legacyCachePath(owner));
      })
      .catch(() => {});
  }
  unsaved.clear();
  return writing;
}

/** Lists that came back empty once, by subscription: a second time in a row, they count. */
const emptyBefore = new Set<string>();

/** The cache files being read, by subscription, so the calls a start sends together read once. */
const reading = new Map<string, Promise<Loaded | null>>();
/** What names each of those reads, by subscription. */
const readings = new Map<string, object>();

/**
 * A subscription's lists from memory, or from disk when the lists in its folder are its
 * account's, or null when there are none yet.
 */
function current(owner: CatalogueOwner): Promise<Loaded | null> {
  const { subscriptionId, key } = owner;
  const kept = loaded.get(subscriptionId);
  if (kept) return Promise.resolve(kept);
  const under = reading.get(subscriptionId);
  if (under) return under;
  /** Names this read: forgetting the subscription, or reading again after that, takes it over. */
  const token = {};
  readings.set(subscriptionId, token);
  const done = (async () => {
    const file =
      (await readJsonFile(cachePath(owner), CachedCatalogue)) ??
      (await readJsonFile(legacyCachePath(owner), CachedCatalogue));
    // Forgotten while reading, when the subscription went.
    if (file?.key !== key || readings.get(subscriptionId) !== token) return null;
    return (
      loaded.get(subscriptionId) ??
      remember(subscriptionId, file.version === 2 ? file.fetchedAt : 0, file)
    );
  })();
  reading.set(subscriptionId, done);
  const settled = () => {
    if (reading.get(subscriptionId) !== done) return;
    reading.delete(subscriptionId);
    readings.delete(subscriptionId);
  };
  done.then(settled, settled);
  return done;
}

/**
 * The catalogue the lists of `owners` make together, for a viewer of `language`: the one made
 * last while it is of the same lists, else made anew. Subscriptions without lists yet add
 * nothing. With `required`, as for a page of a collection, it fails with what the UI explains
 * while subscriptions have lists to load and none has.
 */
async function catalogueOf(
  owners: readonly CatalogueOwner[],
  language: string,
  required = false,
): Promise<Shown> {
  const members = (await Promise.all(owners.map(current))).flatMap((each) => each ?? []);
  if (required && members.length === 0 && owners.length > 0) {
    throw new AppFailure({ kind: "unexpected", detail: "Movies and series haven't loaded yet." });
  }
  const same =
    shown?.index.language === language &&
    shown.members.length === members.length &&
    shown.members.every((each, at) => each === members[at]);
  if (!shown || !same) {
    shown = { members, index: indexCatalogue(members, language), collections: new Map() };
  }
  return shown;
}

/** The collections of a kind as a viewer of `language` sees them, with the metadata so far. */
function collectionsOf(found: Shown, kind: TitleKind): Collections {
  const key = `${kind}|${metadataVersion}`;
  let made = found.collections.get(key);
  if (!made) {
    const { language } = found.index;
    const tmdbKind = kind === "movie" ? "movie" : "tv";
    made = collections({
      kind,
      titles: kindOf(found.index, kind).titles,
      language,
      metadata: (tmdbId) => metadata.get(tmdbKind, tmdbId),
      names: (tmdbId) => metadata.name(tmdbKind, tmdbId, language),
      services: metadata.services(tmdbKind),
      now: Date.now(),
    });
    // Older metadata only takes memory.
    for (const old of found.collections.keys()) {
      if (!old.endsWith(`|${metadataVersion}`)) found.collections.delete(old);
    }
    found.collections.set(key, made);
  }
  return made;
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
  const under = refreshing.get(subscriptionId);
  if (under?.revision === revision) return under.done;
  // This subscription's, under the login it had before. Another subscription's goes on.
  under?.abort.abort();
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
    fetched.set(subscriptionId, { revision, catalogue: kept });
    return null;
  })();
  const running = { revision, done, abort };
  refreshing.set(subscriptionId, running);
  try {
    return await done;
  } finally {
    if (refreshing.get(subscriptionId) === running) refreshing.delete(subscriptionId);
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
  const aside = fetched.get(subscriptionId);
  // Gone already when a call that shared the refresh ended it, or the subscription went.
  if (aside?.revision !== revision) return statusOf(await current(owner));
  fetched.delete(subscriptionId);
  if (!keep) return statusOf(await current(owner));
  const kept = remember(subscriptionId, Date.now(), aside.catalogue);
  // Written after answering, so the lists show without waiting for the disk. Quitting writes
  // them first; a write it cuts short all the same leaves the previous lists for the next start,
  // which refreshes them when due.
  persist(owner, kept);
  return statusOf(kept);
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
  status: async ({ adults: now, owners }) => {
    showing(now);
    return (await Promise.all(owners.map(current))).map(statusOf);
  },
  refresh,
  finishRefresh,
  byIds: async ({ language, kind, versions, owners }) => {
    speaking(language);
    const { index } = await catalogueOf(owners, language);
    return byIds(index, kind, versions).map((title) => named(title, language));
  },
  search: async ({ language, query, owners }) => {
    speaking(language);
    const { index } = await catalogueOf(owners, language);
    const matches = (kind: TitleKind) =>
      search(index, kind, query, aliases).map((title) => named(title, language));
    return { movies: matches("movie"), series: matches("series") };
  },
  searchKind: async ({ language, kind, query, limit, owners }) => {
    speaking(language);
    const { index } = await catalogueOf(owners, language);
    const matches = search(index, kind, query, aliases, Infinity);
    return {
      titles: matches.slice(0, limit).map((title) => named(title, language)),
      total: matches.length,
    };
  },
  rows: async ({ language, kind, tab, like, owners }) => {
    speaking(language);
    const made = collectionsOf(await catalogueOf(owners, language, true), kind);
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
  tiles: async ({ language, kind, of, owners }) => {
    speaking(language);
    const made = collectionsOf(await catalogueOf(owners, language, true), kind);
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
  collection: async ({ language, kind, id, sort, offset, limit, owners }) => {
    speaking(language);
    const made = collectionsOf(await catalogueOf(owners, language, true), kind);
    const titles = made.list(id, sort);
    return {
      name: made.name(id) ?? "",
      total: titles.length,
      titles: titles.slice(offset, offset + limit),
    };
  },
  container: async ({ id, ...owner }) => {
    const found = await current(owner);
    return found?.catalogue.movies.find((movie) => movie.id === id)?.container ?? null;
  },
  forget: async (owner) => {
    const { subscriptionId } = owner;
    refreshing.get(subscriptionId)?.abort.abort();
    refreshing.delete(subscriptionId);
    fetched.delete(subscriptionId);
    reading.delete(subscriptionId);
    readings.delete(subscriptionId);
    loaded.delete(subscriptionId);
    unsaved.delete(subscriptionId);
    for (const list of ["movies", "series"]) emptyBefore.delete(`${subscriptionId}:${list}`);
    // Its titles aren't wanted any more, unless another subscription lists them too.
    metadata.want(wanted(), viewerLanguage);
    await writing;
    await Promise.all([removeFile(cachePath(owner)), removeFile(legacyCachePath(owner))]);
    return null;
  },
  flush: async () => {
    await Promise.all([save(), metadata.flush()]);
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
