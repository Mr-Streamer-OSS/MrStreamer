// Movies and series: the catalogue lives in a worker thread (see ../ondemand/catalogue-worker.ts),
// details come from the provider as a title opens, and playback asks here which file to stream.
// Every call is for the connected subscription; switching accounts clears what the last one had.
import { join } from "node:path";
import type { Worker } from "node:worker_threads";
import type { AppError } from "@mrstreamer/contracts/errors";
import type {
  OnDemandStatus,
  Title,
  TitleCategory,
  TitleDetails,
  TitleKind,
  TitlePage,
  TitleRef,
} from "@mrstreamer/contracts/ondemand";
import { diagnosed } from "@mrstreamer/core/diagnostics";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import type { PageQuery } from "@mrstreamer/core/ondemand/catalogue";
import { movieDetails, seriesDetails } from "@mrstreamer/core/ondemand/details";
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
  WorkerMethod,
  WorkerReply,
  WorkerSetup,
  WorkerStatus,
} from "../ondemand/protocol.ts";
import { Subscriptions, type Source } from "./subscription.ts";

/** How many titles' details stay in memory. Opening one again, or Home, then asks no one. */
const DETAILS_KEPT = 200;

export interface OnDemandDeps {
  readonly dataDir: string;
  readonly userAgent: string;
  /** Starts the catalogue worker: the bundled one in the app, the source file in tests. */
  readonly worker: (setup: WorkerSetup) => Worker;
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
    categories(kind: TitleKind): Effect.Effect<readonly TitleCategory[], Failed>;
    page(query: PageQuery): Effect.Effect<TitlePage, Failed>;
    search(
      query: string,
    ): Effect.Effect<
      { readonly movies: readonly Title[]; readonly series: readonly Title[] },
      Failed
    >;
    details(kind: TitleKind, id: string): Effect.Effect<TitleDetails, Failed>;
    /** The file a movie or episode streams from. */
    file(title: TitleRef): Effect.Effect<TitleFile, Failed>;
    /** Forgets the lists and details, for when the subscription changes or goes. */
    readonly clear: Effect.Effect<void>;
    /** The status after every refresh, successful or not. */
    readonly changes: Stream.Stream<OnDemandStatus>;
  }
>()("mrstreamer/OnDemand") {
  static readonly layer = (deps: OnDemandDeps) => Layer.effect(OnDemand, make(deps));
}

function make(deps: OnDemandDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const updates = yield* PubSub.unbounded<OnDemandStatus>();
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() =>
        workerClient(() =>
          deps.worker({
            cachePath: join(deps.dataDir, "ondemand.json"),
            userAgent: deps.userAgent,
          }),
        ),
      ),
      (client) => Effect.promise(() => client.stop()),
    );
    /** Why the latest refresh of this subscription failed, until one succeeds. */
    let failure: { readonly key: string; readonly error: AppError } | null = null;
    /** Details by subscription, kind and id, oldest first. */
    const details = new Map<string, { raw: ProviderDetails; shown: TitleDetails }>();

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
    });

    const refresh = Effect.gen(function* () {
      const source = yield* requireSource;
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
            failure = { key: source.key, error: failed.error };
            const worked = yield* call("status", { key: source.key }).pipe(
              Effect.orElseSucceed(() => ({ movies: 0, series: 0, fetchedAt: null })),
            );
            yield* PubSub.publish(updates, statusOf(worked, source.key));
          }),
        ),
      );
    });

    /** Runs a call for the connected subscription, fetching the lists first when there are none. */
    const loaded = <A>(run: (source: Source) => Effect.Effect<A, Failed>) =>
      Effect.gen(function* () {
        const source = yield* requireSource;
        const worked = yield* call("status", { key: source.key });
        if (worked.fetchedAt === null) yield* refresh;
        return yield* run(source);
      });

    const detailsOf = (kind: TitleKind, id: string) =>
      Effect.gen(function* () {
        const source = yield* requireSource;
        const cacheKey = `${source.key}|${kind}|${id}`;
        const cached = details.get(cacheKey);
        if (cached) {
          // Most recently used last.
          details.delete(cacheKey);
          details.set(cacheKey, cached);
          return cached;
        }
        const [title] = yield* loaded(() => call("byIds", { key: source.key, kind, ids: [id] }));
        if (!title) return yield* new Failed({ error: { kind: "title-not-found", titleId: id } });
        const raw = yield* Effect.tryPromise({
          try: (signal) =>
            kind === "movie"
              ? source.provider.movieDetails(id, signal)
              : source.provider.seriesDetails(id, signal),
          catch: failedWith,
        }).pipe(diagnosed("details"));
        const found = {
          raw,
          shown: kind === "movie" ? movieDetails(title, raw) : seriesDetails(title, raw),
        };
        // Only for the subscription it was asked for.
        if ((yield* subscriptions.source)?.key === source.key) {
          details.set(cacheKey, found);
          if (details.size > DETAILS_KEPT) details.delete(details.keys().next().value ?? "");
        }
        return found;
      });

    return {
      status: Effect.gen(function* () {
        const source = yield* subscriptions.source;
        if (!source) return { movies: 0, series: 0, fetchedAt: null, failure: null };
        const worked = yield* call("status", { key: source.key }).pipe(
          Effect.orElseSucceed(() => ({ movies: 0, series: 0, fetchedAt: null })),
        );
        return statusOf(worked, source.key);
      }),

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

      categories: (kind: TitleKind) =>
        loaded((source) => call("categories", { key: source.key, kind })),

      page: (query: PageQuery) => loaded((source) => call("page", { key: source.key, query })),

      search: (query: string) => loaded((source) => call("search", { key: source.key, query })),

      details: (kind: TitleKind, id: string) =>
        Effect.map(detailsOf(kind, id), (found) => found.shown),

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
        yield* call("clear", {}).pipe(Effect.ignore);
      }),

      changes: Stream.fromPubSub(updates),
    };
  });
}

/**
 * Calls into the catalogue worker. The worker starts on the first call, and again after it
 * stops unexpectedly; calls in flight when it stops fail.
 */
function workerClient(start: () => Worker) {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (cause: unknown) => void }
  >();

  const failAll = (cause: unknown) => {
    for (const entry of pending.values()) entry.reject(cause);
    pending.clear();
  };

  const running = (): Worker => {
    if (worker) return worker;
    const started = start();
    started.on("message", (reply: WorkerReply) => {
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      if (reply.ok) entry.resolve(reply.value);
      else entry.reject(new Failed({ error: reply.error }));
    });
    started.on("error", (cause) => failAll(cause));
    started.on("exit", () => {
      if (worker === started) worker = null;
      failAll(new Error("The catalogue worker stopped."));
    });
    worker = started;
    return started;
  };

  return {
    call<M extends WorkerMethod>(
      method: M,
      args: WorkerCalls[M]["args"],
    ): Promise<WorkerCalls[M]["result"]> {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        running().postMessage({ id, method, args });
      });
    },
    async stop(): Promise<void> {
      const current = worker;
      worker = null;
      if (current) await current.terminate();
    },
  };
}
