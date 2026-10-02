// Movies and series: the catalogue lives in a worker thread (see ../ondemand/catalogue-worker.ts),
// details come from the provider and TMDB when a title opens, never before, TMDB's episodes when
// their season opens, and playback asks here which file to stream.
// Every call is for the connected subscription; switching accounts clears what the last one had.
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import type { AppError } from "@mrstreamer/contracts/errors";
import type {
  CollectionId,
  CollectionPage,
  CollectionRow,
  CollectionSort,
  CollectionTile,
  EpisodeDetails,
  MetadataProgress,
  OnDemandStatus,
  RowTab,
  Season,
  Title,
  TitleDetails,
  TitleKind,
  TitleMatches,
  TitleRef,
} from "@mrstreamer/contracts/ondemand";
import { diagnosed } from "@mrstreamer/core/diagnostics";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import {
  tmdb,
  TmdbError,
  type EpisodeAbout,
  type TitleAbout,
  type Tmdb,
} from "@mrstreamer/core/metadata/tmdb";
import { movieDetails, seasonEpisodes, seriesDetails } from "@mrstreamer/core/ondemand/details";
import { DEFAULT_TITLE_LANGUAGE } from "@mrstreamer/core/ondemand/languages";
import type { ProviderDetails } from "@mrstreamer/core/provider";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type {
  WorkerCalls,
  WorkerEvent,
  WorkerMethod,
  WorkerReply,
  WorkerSetup,
  WorkerStatus,
} from "../ondemand/protocol.ts";
import { Settings } from "./preferences.ts";
import { Subscriptions, type Source } from "./subscription.ts";

/** How many titles' details stay in memory. Opening one again then asks no one. */
const DETAILS_KEPT = 200;
/** How many seasons TMDB described stay in memory, each in one language. */
const SEASONS_KEPT = 100;
/** How long a title's details, or a season, wait for TMDB; the provider's stand in after that. */
const ABOUT_TIMEOUT_MS = 4000;
/** Search results a Movies or Series page shows; a longer list needs more words. */
const SEARCH_PAGE = 300;

/**
 * How long after a failed first fetch a list asked for fails with it rather than fetching again.
 * Every list the UI shows asks again when the status changes, and the failure changes it.
 */
const RETRY_AFTER_MS = 60_000;

export interface OnDemandDeps {
  readonly dataDir: string;
  readonly userAgent: string;
  /** Starts the catalogue worker: the bundled one in the app, the source file in tests. */
  readonly worker: (setup: WorkerSetup) => Worker;
  /** The app's TMDB key, built in; the viewer's own, from the settings, comes first. */
  readonly tmdbKey: string | null;
  /** ISO 3166-1 country whose streaming services to follow: "NL". */
  readonly region: string;
  /** Another TMDB API, for tests. */
  readonly tmdbApi?: string;
}

/** Which page of which collection. */
export interface CollectionQuery {
  readonly kind: TitleKind;
  readonly id: CollectionId;
  readonly sort?: CollectionSort | undefined;
  readonly offset: number;
  readonly limit: number;
}

/** Where a movie or episode streams from. Contains the login, so it stays in the main process. */
export interface TitleFile {
  readonly url: string;
  readonly container: string;
}

export class OnDemand extends Context.Service<
  OnDemand,
  {
    readonly status: Effect.Effect<OnDemandStatus>;
    /** Fetches both lists. Concurrent calls for one subscription share a fetch. */
    readonly refresh: Effect.Effect<OnDemandStatus, Failed>;
    /** Whether the lists should be fetched again: missing, or older than `maxAge`. */
    isStale(maxAge: Duration.Input): Effect.Effect<boolean>;
    search(
      query: string,
    ): Effect.Effect<
      { readonly movies: readonly Title[]; readonly series: readonly Title[] },
      Failed
    >;
    /** Movies or series matching `query`: the best SEARCH_PAGE, and how many match. */
    searchKind(kind: TitleKind, query: string): Effect.Effect<TitleMatches, Failed>;
    /** A title's details, for when the viewer opens it: the provider's, with TMDB's. */
    details(kind: TitleKind, id: string): Effect.Effect<TitleDetails, Failed>;
    /**
     * The episodes of season `season` of series version `id`, for when the viewer opens it: the
     * provider's, with TMDB's details.
     */
    season(id: string, season: number): Effect.Effect<readonly EpisodeDetails[], Failed>;
    /** Titles by the id of any version, from the lists alone. */
    titles(kind: TitleKind, ids: readonly string[]): Effect.Effect<readonly Title[], Failed>;
    /** A tab's rows; For you starts with titles like `like`, one watched lately. */
    rows(
      kind: TitleKind,
      tab: RowTab,
      like?: string,
    ): Effect.Effect<readonly CollectionRow[], Failed>;
    /** Genres or streaming services as tiles. */
    tiles(
      kind: TitleKind,
      of: "genres" | "services",
    ): Effect.Effect<readonly CollectionTile[], Failed>;
    /** One page of a collection. */
    collection(query: CollectionQuery): Effect.Effect<CollectionPage, Failed>;
    /** The file a movie or episode streams from. */
    file(title: TitleRef): Effect.Effect<TitleFile, Failed>;
    /** Forgets the lists and details, for when the subscription changes or goes. */
    readonly clear: Effect.Effect<void>;
    /** Applies a changed TMDB key from the settings: the worker starts again with it. */
    readonly reconfigure: Effect.Effect<void>;
    /** The status after every refresh, successful or not. */
    readonly changes: Stream.Stream<OnDemandStatus>;
  }
>()("mrstreamer/OnDemand") {
  static readonly layer = (deps: OnDemandDeps) => Layer.effect(OnDemand, make(deps));
}

function make(deps: OnDemandDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const settings = yield* Settings;
    /** The language whose versions titles show and play first. */
    const language = Effect.map(
      settings.get,
      (preferences) => preferences.titleLanguage ?? DEFAULT_TITLE_LANGUAGE,
    );
    const updates = yield* PubSub.unbounded<OnDemandStatus>();
    /** The TMDB key the worker runs with: the viewer's own, or the app's. */
    const keyOf = (preferences: { readonly tmdbKey?: string }) =>
      preferences.tmdbKey?.trim() || deps.tmdbKey;
    let tmdbKey = keyOf(yield* settings.get);
    let metadataProgress: MetadataProgress = {
      known: 0,
      wanted: 0,
      refused: false,
      fetching: false,
    };
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() =>
        workerClient(
          () =>
            deps.worker({
              cachePath: join(deps.dataDir, "ondemand.json.gz"),
              metadataPath: join(deps.dataDir, "metadata.json.gz"),
              userAgent: deps.userAgent,
              tmdb: tmdbKey
                ? {
                    key: tmdbKey,
                    region: deps.region,
                    ...(deps.tmdbApi ? { api: deps.tmdbApi } : {}),
                  }
                : null,
            }),
          (event) => {
            metadataProgress = event.status;
            // The UI refetches what it shows; the lists' own status stays as it was.
            Effect.runFork(publishStatus);
          },
        ),
      ),
      (client) => Effect.promise(() => client.stop()),
    );
    /** Why the latest refresh of this subscription failed, until one succeeds. */
    let failure: { readonly key: string; readonly error: AppError; readonly at: number } | null =
      null;
    /** Counts restarts of the worker. */
    let generation = 0;
    /**
     * What opening a title downloaded, by subscription, language, kind and id, oldest first: the
     * provider's details and TMDB's, with the title as the lists showed it then, for when they no
     * longer list it.
     */
    const details = new Map<
      string,
      { raw: ProviderDetails; about: TitleAbout | null; title: Title }
    >();
    /**
     * What TMDB said about the seasons opened, by TMDB id, season and language, oldest first;
     * null where TMDB doesn't have the season.
     */
    const seasons = new Map<string, readonly EpisodeAbout[] | null>();

    const requireSource = Effect.flatMap(subscriptions.source, (source) =>
      source
        ? Effect.succeed(source)
        : Effect.fail(new Failed({ error: { kind: "no-subscription" } })),
    );

    const call = <M extends WorkerMethod>(method: M, args: WorkerCalls[M]["args"]) =>
      Effect.tryPromise({
        try: () => worker.call(method, args),
        catch: (cause) => (cause instanceof Failed ? cause : failedWith(cause)),
      });

    const statusOf = (worked: WorkerStatus, key: string): OnDemandStatus => ({
      ...worked,
      failure: failure?.key === key ? failure.error : null,
      metadata: tmdbKey ? metadataProgress : null,
    });

    const refresh = Effect.gen(function* () {
      const source = yield* requireSource;
      // A refresh cut short by restarting the worker, as for a new key, isn't a failure to show.
      const started = generation;
      return yield* call("refresh", { key: source.key, account: source.account }).pipe(
        diagnosed("titles"),
        Effect.tap((worked) =>
          Effect.gen(function* () {
            failure = null;
            yield* PubSub.publish(updates, statusOf(worked, source.key));
          }),
        ),
        Effect.map((worked) => statusOf(worked, source.key)),
        Effect.tapError((failed) =>
          Effect.gen(function* () {
            if (started !== generation) return;
            failure = { key: source.key, error: failed.error, at: Date.now() };
            const worked = yield* call("status", { key: source.key }).pipe(
              Effect.orElseSucceed(() => ({ movies: 0, series: 0, fetchedAt: null })),
            );
            yield* PubSub.publish(updates, statusOf(worked, source.key));
          }),
        ),
      );
    });

    /**
     * Runs a call for the connected subscription in the viewer's language, fetching the lists
     * first when there are none.
     */
    const loaded = <A>(run: (source: Source, language: string) => Effect.Effect<A, Failed>) =>
      Effect.gen(function* () {
        const source = yield* requireSource;
        const worked = yield* call("status", { key: source.key });
        if (worked.fetchedAt === null) {
          // Refresh asks the provider again whenever the viewer does.
          if (failure?.key === source.key && Date.now() - failure.at < RETRY_AFTER_MS) {
            return yield* new Failed({ error: failure.error });
          }
          yield* refresh;
        }
        return yield* run(source, yield* language);
      });

    /**
     * A title's details: downloaded when it first opens, then kept, and put together each time with
     * the title as the lists show it now, so its name and original language follow TMDB's metadata
     * as it arrives without downloading anything again.
     */
    const detailsOf = (kind: TitleKind, id: string) =>
      Effect.gen(function* () {
        const source = yield* requireSource;
        const cacheKey = `${source.key}|${yield* language}|${kind}|${id}`;
        const [listed] = yield* loaded((_, language) =>
          call("byIds", { key: source.key, language, kind, ids: [id] }),
        );
        const downloaded = details.get(cacheKey) ?? (yield* download(source, kind, id, listed));
        details.delete(cacheKey);
        // Kept again only for the subscription it was asked for.
        if ((yield* subscriptions.source)?.key === source.key) {
          keep(details, cacheKey, downloaded, DETAILS_KEPT);
        }
        const { raw, about } = downloaded;
        const title = listed ?? downloaded.title;
        // The title as this version: its episodes and its file belong to `id`.
        const version = {
          ...title,
          id,
          tags: title.versions.find((each) => each.id === id)?.tags ?? title.tags,
        };
        return {
          raw,
          about,
          shown:
            kind === "movie"
              ? movieDetails(version, raw, about)
              : seriesDetails(version, raw, about),
        };
      });

    /** Asks the provider and TMDB about a title the lists show, both at once. */
    const download = (source: Source, kind: TitleKind, id: string, title: Title | undefined) =>
      Effect.gen(function* () {
        if (!title) return yield* new Failed({ error: { kind: "title-not-found", titleId: id } });
        const viewer = yield* language;
        const [raw, about] = yield* Effect.all(
          [
            Effect.tryPromise({
              try: (signal) =>
                kind === "movie"
                  ? source.provider.movieDetails(id, signal)
                  : source.provider.seriesDetails(id, signal),
              catch: failedWith,
            }).pipe(diagnosed("details")),
            // TMDB's overview, artwork and credits; without them, the provider's stand.
            Effect.tryPromise((signal) =>
              tmdbKey && title.tmdbId
                ? tmdb({ key: tmdbKey, ...(deps.tmdbApi ? { api: deps.tmdbApi } : {}) }).about(
                    kind === "movie" ? "movie" : "tv",
                    title.tmdbId,
                    viewer,
                    AbortSignal.any([signal, AbortSignal.timeout(ABOUT_TIMEOUT_MS)]),
                  )
                : Promise.resolve(null),
            ).pipe(Effect.orElseSucceed(() => null)),
          ],
          { concurrency: 2 },
        );
        return { raw, about, title };
      });

    /**
     * TMDB's season in one language: kept once TMDB answered, so opening it again asks no one.
     * Null when TMDB doesn't have it, or didn't answer in time; that isn't kept, so opening the
     * season again asks again.
     */
    const seasonIn = (client: Tmdb, tmdbId: string, season: number, asked: string) =>
      Effect.gen(function* () {
        const cacheKey = `${tmdbId}|${season}|${asked}`;
        // A season TMDB doesn't have is kept as null.
        const kept = seasons.get(cacheKey);
        const answer =
          kept !== undefined
            ? kept
            : yield* Effect.tryPromise((signal) =>
                client
                  .season(
                    tmdbId,
                    season,
                    asked,
                    AbortSignal.any([signal, AbortSignal.timeout(ABOUT_TIMEOUT_MS)]),
                  )
                  .catch((cause: unknown) => {
                    if (cause instanceof TmdbError && cause.failure.kind === "missing") return null;
                    throw cause;
                  }),
              ).pipe(Effect.orElseSucceed(() => undefined));
        if (answer === undefined) return null;
        keep(seasons, cacheKey, answer, SEASONS_KEPT);
        return answer;
      });

    const status = Effect.gen(function* () {
      const source = yield* subscriptions.source;
      if (!source) return { movies: 0, series: 0, fetchedAt: null, failure: null, metadata: null };
      const worked = yield* call("status", { key: source.key }).pipe(
        Effect.orElseSucceed(() => ({ movies: 0, series: 0, fetchedAt: null })),
      );
      return statusOf(worked, source.key);
    });
    const publishStatus = Effect.flatMap(status, (current) => PubSub.publish(updates, current));

    return {
      status,

      refresh,

      isStale: (maxAge: Duration.Input) =>
        Effect.gen(function* () {
          const source = yield* subscriptions.source;
          if (!source) return false;
          const worked = yield* call("status", { key: source.key }).pipe(
            Effect.orElseSucceed(() => ({ fetchedAt: null })),
          );
          const now = yield* Clock.currentTimeMillis;
          return worked.fetchedAt === null || now - worked.fetchedAt > Duration.toMillis(maxAge);
        }),

      rows: (kind: TitleKind, tab: RowTab, like?: string) =>
        loaded((source, language) =>
          call("rows", { key: source.key, language, kind, tab, ...(like ? { like } : {}) }),
        ),
      tiles: (kind: TitleKind, of: "genres" | "services") =>
        loaded((source, language) => call("tiles", { key: source.key, language, kind, of })),
      collection: ({ kind, id, sort, offset, limit }: CollectionQuery) =>
        loaded((source, language) =>
          Effect.gen(function* () {
            // Titles for adults only once the viewer asked for them.
            if (id === "adult" && !(yield* settings.get).adultTitles) {
              return { name: "For adults", total: 0, titles: [] };
            }
            return yield* call("collection", {
              key: source.key,
              language,
              kind,
              id,
              offset,
              limit,
              ...(sort ? { sort } : {}),
            });
          }),
        ),
      search: (query: string) =>
        loaded((source, language) => call("search", { key: source.key, language, query })),
      searchKind: (kind: TitleKind, query: string) =>
        loaded((source, language) =>
          call("searchKind", { key: source.key, language, kind, query, limit: SEARCH_PAGE }),
        ),

      details: (kind: TitleKind, id: string) =>
        Effect.map(detailsOf(kind, id), (found) => found.shown),

      season: (id: string, number: number) =>
        Effect.gen(function* () {
          const { shown, about } = yield* detailsOf("series", id);
          const season =
            shown.kind === "series"
              ? shown.seasons.find((each) => each.number === number)
              : undefined;
          if (!season) {
            return yield* new Failed({ error: { kind: "title-not-found", titleId: id } });
          }
          const { tmdbId } = shown.title;
          // TMDB said it as the details opened, if the lists don't know yet.
          const madeIn = shown.title.originalLanguage ?? about?.language;
          const answers: (readonly EpisodeAbout[])[] = [];
          if (tmdbKey && tmdbId) {
            const client = tmdb({ key: tmdbKey, ...(deps.tmdbApi ? { api: deps.tmdbApi } : {}) });
            const viewer = yield* language;
            // Names fall back as titles' do: the viewer's language, English, the series' own. Each
            // is asked for only while an episode TMDB lists still has no name.
            const languages = new Set([viewer, "en", ...(madeIn ? [madeIn] : [])]);
            for (const asked of languages) {
              const answer = yield* seasonIn(client, tmdbId, number, asked);
              if (!answer) break;
              answers.push(answer);
              if (named(season, answers)) break;
            }
          }
          return seasonEpisodes(season, answers);
        }),

      titles: (kind: TitleKind, ids: readonly string[]) =>
        ids.length === 0
          ? Effect.succeed([])
          : loaded((source, language) => call("byIds", { key: source.key, language, kind, ids })),

      file: (title: TitleRef) =>
        Effect.gen(function* () {
          const source = yield* requireSource;
          const missing = new Failed({ error: { kind: "title-not-found", titleId: title.id } });
          if (title.kind === "movie") {
            const container = yield* loaded(() =>
              call("container", { key: source.key, id: title.id }),
            );
            if (!container) return yield* missing;
            return { url: source.provider.titleFile("movie", title.id, container), container };
          }
          const series = yield* detailsOf("series", title.seriesId);
          const episode = series.raw.episodes.find((each) => each.id === title.id);
          if (!episode) return yield* missing;
          return {
            url: source.provider.titleFile("episode", title.id, episode.container),
            container: episode.container,
          };
        }),

      clear: Effect.gen(function* () {
        failure = null;
        details.clear();
        seasons.clear();
        yield* call("clear", {}).pipe(Effect.ignore);
      }),

      reconfigure: Effect.gen(function* () {
        const next = keyOf(yield* settings.get);
        if (next === tmdbKey) return;
        tmdbKey = next;
        generation++;
        failure = null;
        metadataProgress = { known: 0, wanted: 0, refused: false, fetching: false };
        // The next call starts the worker again, with the new key.
        yield* Effect.promise(() => worker.stop());
        yield* publishStatus;
      }),

      changes: Stream.fromPubSub(updates),
    };
  });
}

/** Keeps `value` as the most recently used, dropping the least recently used beyond `limit`. */
function keep<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value ?? "");
}

/** Whether every episode of `season` that TMDB lists has a name in one of its answers. */
function named(season: Season, answers: readonly (readonly EpisodeAbout[])[]): boolean {
  const [first = []] = answers;
  return season.episodes.every(
    (episode) =>
      !first.some((each) => each.number === episode.number) ||
      answers.some((answer) =>
        answer.some((each) => each.number === episode.number && each.name !== null),
      ),
  );
}

/**
 * Calls into the catalogue worker. The worker starts on the first call, and again after it
 * stops unexpectedly; calls in flight when it stops fail.
 */
function workerClient(start: () => Worker, onEvent: (event: WorkerEvent) => void) {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: unknown) => void; worker: Worker }
  >();

  /** Fails the calls `from` was given, and only those: another may have started meanwhile. */
  const failAll = (from: Worker, cause: unknown) => {
    for (const [id, entry] of pending) {
      if (entry.worker !== from) continue;
      pending.delete(id);
      entry.reject(cause);
    }
  };

  const running = (): Worker => {
    if (worker) return worker;
    const started = start();
    started.on("message", (reply: WorkerReply | WorkerEvent) => {
      if ("event" in reply) return onEvent(reply);
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      if (reply.ok) entry.resolve(reply.value);
      else entry.reject(new Failed({ error: reply.error }));
    });
    started.on("error", (cause) => failAll(started, cause));
    started.on("exit", () => {
      if (worker === started) worker = null;
      failAll(started, new Error("The catalogue worker stopped."));
    });
    worker = started;
    return started;
  };

  const call = <M extends WorkerMethod>(
    method: M,
    args: WorkerCalls[M]["args"],
  ): Promise<WorkerCalls[M]["result"]> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const to = running();
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, worker: to });
      to.postMessage({ id, method, args });
    });
  };

  return {
    call,
    async stop(): Promise<void> {
      const current = worker;
      if (!current) return;
      // A cache write in progress gets a moment to finish, so the next start reads it.
      const flushed = call("flush", {}).catch(() => null);
      await Promise.race([flushed, new Promise((done) => setTimeout(done, 2000))]);
      if (worker === current) worker = null;
      await current.terminate();
    },
  };
}
