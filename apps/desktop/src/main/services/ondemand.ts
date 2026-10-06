// Movies and series: the catalogue lives in a worker thread (see ../ondemand/catalogue-worker.ts),
// details come from the provider and TMDB when a title opens, never before, TMDB's episodes when
// their season opens, and playback asks here which file to stream. A title's details don't wait
// for TMDB: what it says joins them once it arrives, and `detailsChanged` says so.
// A title, version or episode a call names says which subscription lists it, and one of a
// subscription that isn't saved finds nothing. The lists are the saved subscription's; switching
// accounts clears what the last one had.
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
import type { OwnedId } from "@mrstreamer/contracts/subscription";
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
import * as Fiber from "effect/Fiber";
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
import { sameSource, Subscriptions, type Source } from "./subscription.ts";

/** How many titles' details stay in memory. Opening one again then asks no one. */
const DETAILS_KEPT = 200;
/** How many seasons TMDB described stay in memory, each in one language. */
const SEASONS_KEPT = 100;
/** How long TMDB gets to describe a title, or a season; the provider's details stand after that. */
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
    /**
     * Fetches both lists. Concurrent calls for one subscription share a fetch. Lists that arrive
     * after the subscription's login changed are dropped: it fails, and those from before stay.
     */
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
    /**
     * A version's details, for when the viewer opens it: the provider's, with TMDB's once it has
     * answered. They come as soon as the provider answers; `detailsChanged` says when TMDB's
     * arrive later. Fails with `no-subscription` when the version's subscription isn't saved.
     */
    details(kind: TitleKind, version: OwnedId): Effect.Effect<TitleDetails, Failed>;
    /**
     * The episodes of season `season` of a series version, for when the viewer opens it: the
     * provider's, with TMDB's details.
     */
    season(series: OwnedId, season: number): Effect.Effect<readonly EpisodeDetails[], Failed>;
    /** Titles by any of their versions, from the lists alone. */
    titles(kind: TitleKind, versions: readonly OwnedId[]): Effect.Effect<readonly Title[], Failed>;
    /** A tab's rows; For you starts with titles like `like`, a version of one watched lately. */
    rows(
      kind: TitleKind,
      tab: RowTab,
      like?: OwnedId,
    ): Effect.Effect<readonly CollectionRow[], Failed>;
    /** Genres or streaming services as tiles. */
    tiles(
      kind: TitleKind,
      of: "genres" | "services",
    ): Effect.Effect<readonly CollectionTile[], Failed>;
    /** One page of a collection. */
    collection(query: CollectionQuery): Effect.Effect<CollectionPage, Failed>;
    /** The file a movie or episode streams from, at the provider of the subscription it names. */
    file(title: TitleRef): Effect.Effect<TitleFile, Failed>;
    /** Forgets the lists and details, for when the subscription changes or goes. */
    readonly clear: Effect.Effect<void>;
    /** Applies a changed TMDB key from the settings: the worker starts again with it. */
    readonly reconfigure: Effect.Effect<void>;
    /** The status after every refresh, successful or not. */
    readonly changes: Stream.Stream<OnDemandStatus>;
    /** A title whose details were given before TMDB's arrived, now that they have. */
    readonly detailsChanged: Stream.Stream<TitleKey>;
  }
>()("mrstreamer/OnDemand") {
  static readonly layer = (deps: OnDemandDeps) => Layer.effect(OnDemand, make(deps));
}

/** A movie or series version. */
interface TitleKey extends OwnedId {
  readonly kind: TitleKind;
}

/**
 * What opening a title downloaded from the provider, as of the refresh of the lists that `lists`
 * counts, with the title as the lists showed it then, for when they no longer list it.
 */
interface Downloaded {
  readonly raw: ProviderDetails;
  readonly lists: number;
  readonly title: Title;
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
    const detailed = yield* PubSub.unbounded<TitleKey>();
    const scope = yield* Effect.scope;
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
    let failure: {
      readonly subscriptionId: string;
      readonly error: AppError;
      readonly at: number;
    } | null = null;
    /** Counts restarts of the worker. */
    let generation = 0;
    /**
     * Rises with each refresh of the lists. Details downloaded before ask the provider again, as
     * it may list new episodes.
     */
    let listsVersion = 0;
    /** What opening a title downloaded, by subscription, language, kind and id, oldest first. */
    const details = new Map<string, Downloaded>();
    /**
     * What TMDB said about the titles opened, by the same keys; null where TMDB doesn't have the
     * title. One it didn't answer about, or had no key for, isn't kept, so opening it asks again.
     */
    const abouts = new Map<string, TitleAbout | null>();
    /** The questions to TMDB about titles on their way, by the same keys. */
    const asking = new Map<string, Fiber.Fiber<void>>();
    /** Of those, the ones whose details were given without TMDB's. */
    const late = new Set<string>();
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

    /** Whose catalogue a call to the worker is about. */
    const ownerOf = ({ id, key }: Source) => ({ subscriptionId: id, key });

    /** The worker's status for `source`, telling it whether the viewer shows titles for adults. */
    const askStatus = (source: Source) =>
      Effect.flatMap(settings.get, (preferences) =>
        call("status", { ...ownerOf(source), adults: preferences.adultTitles ?? false }),
      );

    const statusOf = (worked: WorkerStatus, source: Source): OnDemandStatus => ({
      ...worked,
      failure: failure?.subscriptionId === source.id ? failure.error : null,
      metadata: tmdbKey ? metadataProgress : null,
    });

    const refresh = Effect.gen(function* () {
      const source = yield* requireSource;
      // A refresh cut short by restarting the worker, as for a new key, isn't a failure to show.
      const started = generation;
      const { revision, account } = source;
      const owner = { ...ownerOf(source), revision };
      /**
       * Whether the login the lists were asked under is still the saved one. What the provider
       * answered under one that isn't, lists or a refusal, is neither kept nor told.
       */
      const stands = Effect.map(subscriptions.source, (now) => sameSource(source, now));
      // The worker fetches the lists and sets them aside; it keeps them only once told to.
      const fetched = Effect.gen(function* () {
        yield* call("refresh", { ...owner, account });
        const keep = yield* stands;
        const worked = yield* call("finishRefresh", { ...owner, keep });
        return keep ? worked : yield* switched;
      });
      return yield* fetched.pipe(
        diagnosed("titles"),
        Effect.tap((worked) =>
          Effect.gen(function* () {
            failure = null;
            listsVersion++;
            yield* PubSub.publish(updates, statusOf(worked, source));
          }),
        ),
        Effect.map((worked) => statusOf(worked, source)),
        Effect.tapError((failed) =>
          Effect.gen(function* () {
            if (started !== generation || !(yield* stands)) return;
            failure = { subscriptionId: source.id, error: failed.error, at: Date.now() };
            const worked = yield* askStatus(source).pipe(
              Effect.orElseSucceed(() => ({ movies: 0, series: 0, fetchedAt: null })),
            );
            yield* PubSub.publish(updates, statusOf(worked, source));
          }),
        ),
      );
    });

    /**
     * Runs a call for `source`, the saved subscription, in the viewer's language, fetching the
     * lists first when there are none.
     */
    const loadedFor = <A>(source: Source, run: (language: string) => Effect.Effect<A, Failed>) =>
      Effect.gen(function* () {
        const worked = yield* askStatus(source);
        if (worked.fetchedAt === null) {
          // Refresh asks the provider again whenever the viewer does.
          if (failure?.subscriptionId === source.id && Date.now() - failure.at < RETRY_AFTER_MS) {
            return yield* new Failed({ error: failure.error });
          }
          yield* refresh;
        }
        return yield* run(yield* language);
      });
    const loaded = <A>(run: (source: Source, language: string) => Effect.Effect<A, Failed>) =>
      Effect.flatMap(requireSource, (source) =>
        loadedFor(source, (language) => run(source, language)),
      );

    /**
     * A version's details: downloaded when it first opens, then kept, and put together each time
     * with the title as the lists show it now, so its name and original language follow TMDB's
     * metadata as it arrives without downloading anything again. TMDB is asked at the same time,
     * and what it said by the time the provider answered is in them.
     */
    const detailsOf = (kind: TitleKind, { subscriptionId, id }: OwnedId) =>
      Effect.gen(function* () {
        const source = yield* subscriptions.sourceOf(subscriptionId);
        const viewer = yield* language;
        const cacheKey = `${source.id}|${viewer}|${kind}|${id}`;
        const [listed] = yield* loadedFor(source, (language) =>
          call("byIds", { ...ownerOf(source), language, kind, ids: [id] }),
        );
        const kept = details.get(cacheKey);
        const title = listed ?? kept?.title;
        if (!title) return yield* new Failed({ error: { kind: "title-not-found", titleId: id } });
        yield* askAbout(source, cacheKey, { subscriptionId, kind, id }, title);
        const downloaded = kept
          ? yield* renewed(source, kind, id, kept)
          : yield* download(source, kind, id, title);
        details.delete(cacheKey);
        // Kept again only for the subscription it was asked for, with the login it had.
        if (sameSource(source, yield* subscriptions.source)) {
          keep(details, cacheKey, downloaded, DETAILS_KEPT);
        }
        if (asking.has(cacheKey)) late.add(cacheKey);
        const about = abouts.get(cacheKey) ?? null;
        const { raw } = downloaded;
        // The title as this version: its episodes and its file belong to `id`.
        const version = {
          ...title,
          id,
          tags: title.versions.find((each) => each.id === id)?.tags ?? title.tags,
        };
        return {
          raw,
          /** What TMDB said about the title, once the question on its way is answered. */
          about: Effect.gen(function* () {
            const asked = asking.get(cacheKey);
            if (asked) yield* Fiber.join(asked);
            return abouts.get(cacheKey) ?? null;
          }),
          shown:
            kind === "movie"
              ? movieDetails(version, raw, about)
              : seriesDetails(version, raw, about, viewer),
        };
      });

    /** The provider's details of a movie or series. */
    const providerDetails = (source: Source, kind: TitleKind, id: string) =>
      Effect.tryPromise({
        try: (signal) =>
          kind === "movie"
            ? source.provider.movieDetails(id, signal)
            : source.provider.seriesDetails(id, signal),
        catch: failedWith,
      }).pipe(diagnosed("details"));

    /**
     * Asks TMDB about a title in the background, for its overview, artwork and credits, unless it
     * answered already or is being asked. Its answer is kept for the subscription it was asked
     * for, and announced when the title's details were given without it.
     */
    const askAbout = (source: Source, cacheKey: string, ref: TitleKey, title: Title) =>
      Effect.gen(function* () {
        if (abouts.has(cacheKey) || asking.has(cacheKey)) return;
        if (!title.tmdbId) return keep(abouts, cacheKey, null, DETAILS_KEPT);
        if (!tmdbKey) return;
        const { tmdbId } = title;
        const client = tmdb({ key: tmdbKey, ...(deps.tmdbApi ? { api: deps.tmdbApi } : {}) });
        const viewer = yield* language;
        const answered = (about: TitleAbout | null | undefined) =>
          Effect.gen(function* () {
            asking.delete(cacheKey);
            const given = late.delete(cacheKey);
            if (about === undefined || (yield* subscriptions.source)?.id !== source.id) return;
            keep(abouts, cacheKey, about, DETAILS_KEPT);
            if (given && about) yield* PubSub.publish(detailed, ref);
          });
        // Listed once forked: its answer takes a round trip to TMDB, so it never comes first.
        const asked = yield* Effect.forkIn(
          Effect.tryPromise((signal) =>
            client
              .about(
                ref.kind === "movie" ? "movie" : "tv",
                tmdbId,
                viewer,
                AbortSignal.any([signal, AbortSignal.timeout(ABOUT_TIMEOUT_MS)]),
              )
              .catch((cause: unknown) => {
                if (cause instanceof TmdbError && cause.failure.kind === "missing") return null;
                throw cause;
              }),
          ).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.flatMap(answered),
          ),
          scope,
        );
        asking.set(cacheKey, asked);
      });

    /** Asks the provider about a title the lists show. */
    const download = (source: Source, kind: TitleKind, id: string, title: Title) => {
      const lists = listsVersion;
      return Effect.map(providerDetails(source, kind, id), (raw) => ({ raw, lists, title }));
    };

    /**
     * Details kept from an earlier open, asked again after the lists were refreshed, as the
     * provider may list new episodes; if that fails, the old ones stand.
     */
    const renewed = (source: Source, kind: TitleKind, id: string, kept: Downloaded) => {
      const lists = listsVersion;
      return kept.lists === lists
        ? Effect.succeed(kept)
        : providerDetails(source, kind, id).pipe(
            Effect.map((raw) => ({ ...kept, raw, lists })),
            Effect.orElseSucceed(() => kept),
          );
    };

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
      const worked = yield* askStatus(source).pipe(
        Effect.orElseSucceed(() => ({ movies: 0, series: 0, fetchedAt: null })),
      );
      return statusOf(worked, source);
    });
    const publishStatus = Effect.flatMap(status, (current) => PubSub.publish(updates, current));

    return {
      status,

      refresh,

      isStale: (maxAge: Duration.Input) =>
        Effect.gen(function* () {
          const source = yield* subscriptions.source;
          if (!source) return false;
          const worked = yield* askStatus(source).pipe(
            Effect.orElseSucceed(() => ({ fetchedAt: null })),
          );
          const now = yield* Clock.currentTimeMillis;
          return worked.fetchedAt === null || now - worked.fetchedAt > Duration.toMillis(maxAge);
        }),

      rows: (kind: TitleKind, tab: RowTab, like?: OwnedId) =>
        loaded((source, language) =>
          call("rows", { ...ownerOf(source), language, kind, tab, ...(like ? { like } : {}) }),
        ),
      tiles: (kind: TitleKind, of: "genres" | "services") =>
        loaded((source, language) => call("tiles", { ...ownerOf(source), language, kind, of })),
      collection: ({ kind, id, sort, offset, limit }: CollectionQuery) =>
        loaded((source, language) =>
          Effect.gen(function* () {
            // Titles for adults only once the viewer asked for them.
            if (id === "adult" && !(yield* settings.get).adultTitles) {
              return { name: "For adults", total: 0, titles: [] };
            }
            return yield* call("collection", {
              ...ownerOf(source),
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
        loaded((source, language) => call("search", { ...ownerOf(source), language, query })),
      searchKind: (kind: TitleKind, query: string) =>
        loaded((source, language) =>
          call("searchKind", { ...ownerOf(source), language, kind, query, limit: SEARCH_PAGE }),
        ),

      details: (kind: TitleKind, version: OwnedId) =>
        Effect.map(detailsOf(kind, version), (found) => found.shown),

      season: (series: OwnedId, number: number) =>
        Effect.gen(function* () {
          const { shown, about } = yield* detailsOf("series", series);
          const season =
            shown.kind === "series"
              ? shown.seasons.find((each) => each.number === number)
              : undefined;
          if (!season) {
            return yield* new Failed({ error: { kind: "title-not-found", titleId: series.id } });
          }
          const { tmdbId, originalLanguage } = shown.title;
          const answers: (readonly EpisodeAbout[])[] = [];
          if (tmdbKey && tmdbId) {
            const client = tmdb({ key: tmdbKey, ...(deps.tmdbApi ? { api: deps.tmdbApi } : {}) });
            // Names fall back as titles' do: the viewer's language, English, the series' own,
            // which TMDB says as the details open if the lists don't know it yet. Each is asked
            // for only while an episode TMDB lists still has no name.
            const madeIn = originalLanguage
              ? Effect.succeed(originalLanguage)
              : Effect.map(about, (said) => said?.language ?? null);
            const asked = new Set<string>();
            for (const next of [language, Effect.succeed("en"), madeIn]) {
              const wanted = yield* next;
              if (!wanted || asked.has(wanted)) continue;
              asked.add(wanted);
              const answer = yield* seasonIn(client, tmdbId, number, wanted);
              if (!answer) break;
              answers.push(answer);
              if (named(season, answers)) break;
            }
          }
          return seasonEpisodes(season, answers);
        }),

      titles: (kind: TitleKind, versions: readonly OwnedId[]) =>
        versions.length === 0
          ? Effect.succeed([])
          : loaded((source, language) => {
              // Versions of another subscription aren't in these lists, whatever their ids.
              const ids = versions.flatMap((version) =>
                version.subscriptionId === source.id ? [version.id] : [],
              );
              return call("byIds", { ...ownerOf(source), language, kind, ids });
            }),

      file: (title: TitleRef) =>
        Effect.gen(function* () {
          const source = yield* subscriptions.sourceOf(title.subscriptionId);
          const missing = new Failed({ error: { kind: "title-not-found", titleId: title.id } });
          if (title.kind === "movie") {
            const container = yield* loadedFor(source, () =>
              call("container", { ...ownerOf(source), id: title.id }),
            );
            if (!container) return yield* missing;
            return { url: source.provider.titleFile("movie", title.id, container), container };
          }
          const series = yield* detailsOf("series", {
            subscriptionId: title.subscriptionId,
            id: title.seriesId,
          });
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
        abouts.clear();
        asking.clear();
        late.clear();
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

      detailsChanged: Stream.fromPubSub(detailed),
    };
  });
}

const switched = Effect.fail(
  new Failed({
    error: { kind: "unexpected", detail: "The subscription changed while loading titles." },
  }),
);

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
