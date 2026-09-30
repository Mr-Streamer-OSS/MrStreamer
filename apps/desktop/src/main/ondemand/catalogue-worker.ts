// The movie and series catalogue, in a worker thread. Its lists run to tens of megabytes, and
// reading, indexing and sorting them would hold the main process for hundreds of milliseconds;
// here that costs nothing the viewer notices. The main process sends small calls and gets pages.
//
// The catalogue on disk (ondemand.json) keeps the provider's lists as they came, for one
// subscription; display names are worked out on load.
import { workerData, parentPort } from "node:worker_threads";
import { type } from "arktype";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import {
  byIds,
  indexCatalogue,
  kindOf,
  page,
  search,
  type IndexedCatalogue,
} from "@mrstreamer/core/ondemand/catalogue";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import { readJsonFile, removeFile, writeJsonFile } from "../platform/json-file.ts";
import { xtreamProvider } from "../providers/xtream.ts";
import type { WorkerCalls, WorkerRequest, WorkerSetup, WorkerStatus } from "./protocol.ts";

const setup = workerData as WorkerSetup;

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
});
const CachedCatalogue = type({
  version: "1",
  /** Which subscription produced it. */
  key: "string",
  fetchedAt: "number",
  movieCategories: Category.array(),
  movies: ProviderTitle.array(),
  seriesCategories: Category.array(),
  series: ProviderTitle.array(),
});

interface Loaded {
  readonly key: string;
  readonly fetchedAt: number;
  readonly index: IndexedCatalogue;
  readonly movies: number;
  readonly series: number;
}

let loaded: Loaded | null = null;
/** The refresh in flight, shared by calls for the same account. */
let refreshing: {
  readonly key: string;
  readonly done: Promise<WorkerStatus>;
  readonly abort: AbortController;
} | null = null;

function remember(key: string, fetchedAt: number, catalogue: OnDemandCatalogue): Loaded {
  loaded = {
    key,
    fetchedAt,
    index: indexCatalogue(catalogue),
    movies: catalogue.movies.length,
    series: catalogue.series.length,
  };
  return loaded;
}

/** Lists that came back empty once, by subscription: a second time in a row, they count. */
const emptyBefore = new Set<string>();

/** The cache file being read, so the calls a start sends together read it once. */
let reading: { readonly key: string; readonly done: Promise<Loaded | null> } | null = null;

/** The catalogue for `key` from memory or disk, or null when there is none yet. */
function current(key: string): Promise<Loaded | null> {
  if (loaded?.key === key) return Promise.resolve(loaded);
  if (reading?.key === key) return reading.done;
  const done = (async () => {
    const file = await readJsonFile(setup.cachePath, CachedCatalogue);
    // Cleared while reading, when the account went.
    if (file?.key !== key || reading?.key !== key) return null;
    return loaded?.key === key ? loaded : remember(key, file.fetchedAt, file);
  })();
  reading = { key, done };
  const settled = () => {
    if (reading?.done === done) reading = null;
  };
  done.then(settled, settled);
  return done;
}

/** The catalogue for `key`, or the failure the UI explains when nothing is loaded yet. */
async function required(key: string): Promise<Loaded> {
  const found = await current(key);
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

async function refresh(args: WorkerCalls["refresh"]["args"]): Promise<WorkerStatus> {
  if (refreshing?.key === args.key) return refreshing.done;
  refreshing?.abort.abort();
  const abort = new AbortController();
  const done = (async () => {
    const provider = xtreamProvider(args.account, { userAgent: setup.userAgent });
    const catalogue = await provider.onDemandCatalogue(abort.signal);
    const before = await current(args.key);
    // An empty list doesn't replace one that had titles, unless it comes twice in a row, as for
    // channels: panels answer an overloaded request with an empty list, and one list can fail
    // while the other arrives.
    for (const list of ["movies", "series"] as const) {
      const mark = `${args.key}:${list}`;
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
    const fetchedAt = Date.now();
    // Written before it is used: the next start must not find an older catalogue on disk.
    await writeJsonFile(setup.cachePath, { version: 1, key: args.key, fetchedAt, ...catalogue });
    return statusOf(remember(args.key, fetchedAt, catalogue));
  })();
  const running = { key: args.key, done, abort };
  refreshing = running;
  try {
    return await done;
  } finally {
    if (refreshing === running) refreshing = null;
  }
}

const handlers: {
  [M in keyof WorkerCalls]: (args: WorkerCalls[M]["args"]) => Promise<WorkerCalls[M]["result"]>;
} = {
  status: async ({ key }) => statusOf(await current(key)),
  refresh,
  categories: async ({ key, kind }) => kindOf((await required(key)).index, kind).categories,
  page: async ({ key, query }) => page((await required(key)).index, query),
  byIds: async ({ key, kind, ids }) => {
    const found = await current(key);
    return found ? byIds(found.index, kind, ids) : [];
  },
  search: async ({ key, query }) => {
    const found = await current(key);
    if (!found) return { movies: [], series: [] };
    return {
      movies: search(found.index, "movie", query),
      series: search(found.index, "series", query),
    };
  },
  container: async ({ key, id }) => (await current(key))?.index.movies.containers.get(id) ?? null,
  clear: async () => {
    refreshing?.abort.abort();
    refreshing = null;
    reading = null;
    loaded = null;
    emptyBefore.clear();
    await removeFile(setup.cachePath);
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
