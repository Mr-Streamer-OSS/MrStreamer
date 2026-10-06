// The programme guide service. It keeps the current subscription's guide in memory, reads it from
// the store after a restart, downloads it again when it is six hours old, and forgets it when the
// account changes. Browsing and playback never wait for it: lookups answer empty until a guide
// has loaded.
//
// A subscription can answer that it has no guide, as a playlist does whose first line names none.
// That is an answer like any other: a guide loaded before is dropped, the status says so, and the
// service doesn't ask again on its own until the app starts again. Only a refresh the viewer asks
// for does. Until a subscription has answered, whether it has a guide is unknown.
//
// The app supplies three ports: the subscription and its download, the catalogue's guide ids, and
// a store for the document as it arrived. Downloads run in the service's scope, so `clear` and
// shutdown stop them, and a load or download that finishes after a `clear` changes nothing.
import type {
  GuideStatus,
  Listing,
  ListingMatch,
  Programme,
  ProgrammeMatch,
} from "@mrstreamer/contracts/guide";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { diagnosed } from "../diagnostics.ts";
import { Failed, failedWith } from "../failure.ts";
import type { LiveGuide } from "../provider.ts";
import {
  channelsCovered,
  indexProgrammes,
  listingsAt,
  scheduleAt,
  searchAt,
  searchChannelsAt,
  type GuideChannels,
  type ProgrammeIndex,
} from "./programmes.ts";

/** A guide older than this is downloaded again. Providers cover about a day ahead. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** How often the service checks whether the guide is due. */
const CHECK_EVERY = "15 minutes";

/** The subscription whose guide to keep: its identity and its XMLTV download. */
export interface GuideSubscription {
  /** Changes when the account does. */
  readonly key: string;
  /** Asks the subscription for its guide now: the document, or that it has none. */
  download(signal: AbortSignal): Promise<LiveGuide>;
}

/** Which subscription is connected. */
export class GuideSource extends Context.Service<
  GuideSource,
  { readonly current: Effect.Effect<GuideSubscription | null> }
>()("mrstreamer/GuideSource") {}

/** The current catalogue's channels by guide id. */
export class GuideCatalogue extends Context.Service<
  GuideCatalogue,
  { readonly channels: Effect.Effect<GuideChannels, Failed> }
>()("mrstreamer/GuideCatalogue") {}

/** A document being saved as it downloads. Nothing replaces the saved one until `commit`. */
export interface GuideDraft {
  write(bytes: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

/** Where the last complete document is kept, for the next start. */
export class GuideStore extends Context.Service<
  GuideStore,
  {
    /** The saved document of `key` and when it was downloaded, or null. */
    readonly read: (
      key: string,
    ) => Effect.Effect<{ fetchedAt: number; document: AsyncIterable<Uint8Array> } | null>;
    readonly save: (key: string, fetchedAt: number) => Effect.Effect<GuideDraft, Failed>;
    readonly clear: Effect.Effect<void>;
  }
>()("mrstreamer/GuideStore") {}

interface Loaded extends ProgrammeIndex {
  readonly key: string;
  readonly fetchedAt: number;
}

export class Guide extends Context.Service<
  Guide,
  {
    /** What each channel shows now and next. Channels without guide data are left out. */
    listings(channelIds: readonly string[]): Effect.Effect<Record<string, Listing>>;
    /** The channel's programme on now and the rest the guide knows. */
    schedule(channelId: string): Effect.Effect<readonly Programme[]>;
    /** Programmes on now or later whose title matches, on now first. */
    search(query: string): Effect.Effect<readonly ProgrammeMatch[]>;
    /**
     * What a search finds in the programmes of the given channels, by channel id: on now, and
     * the first later one that starts before `until`. Every channel given is searched.
     */
    searchChannels(
      query: string,
      channelIds: readonly string[],
      until: number,
    ): Effect.Effect<Record<string, ListingMatch>>;
    /**
     * How many channels the loaded guide covers and when it was downloaded, or that the
     * subscription has none.
     */
    readonly status: Effect.Effect<GuideStatus>;
    /**
     * Asks the subscription for its guide and downloads it. Concurrent calls share a download; a
     * failure keeps the guide. A subscription that answers it has none succeeds, and a guide
     * loaded before goes.
     */
    readonly refresh: Effect.Effect<void, Failed>;
    /**
     * Downloads the guide when there is none or it is six hours old. A subscription that
     * answered it has none isn't asked again.
     */
    readonly refreshIfStale: Effect.Effect<void, Failed>;
    /** Forgets the guide and stops a download, for when the account changes or goes. */
    readonly clear: Effect.Effect<void>;
    /** Emits whenever a new guide is loaded, or the one loaded is dropped. */
    readonly changes: Stream.Stream<void>;
  }
>()("mrstreamer/Guide") {
  static readonly layer = Layer.effect(Guide, make());
}

function make() {
  return Effect.gen(function* () {
    const source = yield* GuideSource;
    const catalogue = yield* GuideCatalogue;
    const store = yield* GuideStore;
    const scope = yield* Effect.scope;
    const updates = yield* PubSub.unbounded<void>();
    const loadOne = yield* Semaphore.make(1);

    let loaded: Loaded | null = null;
    /** The subscription that answered it has no guide, by key, until it answers otherwise. */
    let absent: string | null = null;
    /**
     * Rises whenever the guide is dropped, by `clear` or by a subscription that has none any
     * more, so work that started before it doesn't apply its result.
     */
    let generation = 0;
    /** The fiber of each download, for its own cleanup to recognise it. */
    const fiberOf = new WeakMap<object, Fiber.Fiber<void, Failed>>();
    let downloading: {
      readonly key: string;
      readonly fiber: Fiber.Fiber<void, Failed>;
    } | null = null;

    /** The guide of the current subscription: from memory, or read from the store once. */
    const current = Effect.gen(function* () {
      const subscription = yield* source.current;
      // Nothing is kept for a subscription without a guide, so there is nothing to read.
      if (!subscription || absent === subscription.key) return null;
      if (loaded?.key === subscription.key) return loaded;
      return yield* loadOne.withPermits(1)(readStored(subscription.key));
    });

    const readStored = (key: string) =>
      Effect.gen(function* () {
        if (loaded?.key === key) return loaded;
        const started = generation;
        const saved = yield* store
          .read(key)
          .pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning("[guide] can't read the guide on disk", defect).pipe(
                Effect.as(null),
              ),
            ),
          );
        if (!saved) return null;
        const since = yield* Clock.currentTimeMillis;
        const index = yield* Effect.tryPromise({
          try: () => indexProgrammes(saved.document, since),
          catch: failedWith,
        }).pipe(
          Effect.catchTag("Failed", (failure) =>
            Effect.logWarning("[guide] ignoring the guide on disk", failure.error).pipe(
              Effect.as(null),
            ),
          ),
        );
        if (!index || generation !== started) return null;
        loaded = { key, fetchedAt: saved.fetchedAt, ...index };
        return loaded;
      });

    /**
     * Asks for the guide and downloads it, saving as it arrives; the new guide replaces the old
     * only once complete. A subscription that has none leaves none behind, in memory or on disk.
     */
    const download = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const started = generation;
        const fetchedAt = yield* Clock.currentTimeMillis;
        // Asking and reading share one signal, so stopping the download stops either.
        const index = yield* Effect.acquireUseRelease(
          store.save(subscription.key, fetchedAt),
          (draft) =>
            Effect.tryPromise({
              try: async (signal) => {
                const guide = await subscription.download(signal);
                return guide.kind === "none"
                  ? null
                  : indexProgrammes(saving(guide.body, draft), fetchedAt);
              },
              catch: failedWith,
            }),
          (draft, exit) =>
            Effect.promise(async () => {
              const keep = Exit.isSuccess(exit) && exit.value !== null && generation === started;
              await (keep ? draft.commit() : draft.discard());
            }),
        );
        const now = yield* source.current;
        if (generation !== started || now?.key !== subscription.key) return;
        if (index === null) {
          const known = absent === subscription.key;
          absent = subscription.key;
          // Asked again and still none: nothing changed, so nothing is told.
          if (known) return;
          // A guide loaded or being read from disk is the one the subscription had before.
          generation++;
          loaded = null;
          yield* store.clear;
          yield* PubSub.publish(updates, undefined);
          return;
        }
        absent = null;
        loaded = { key: subscription.key, fetchedAt, ...index };
        yield* PubSub.publish(updates, undefined);
      }).pipe(diagnosed("guide"));

    const refresh = Effect.gen(function* () {
      const subscription = yield* source.current;
      if (!subscription) return yield* new Failed({ error: { kind: "no-subscription" } });
      let running = downloading?.key === subscription.key ? downloading : null;
      if (!running) {
        const token = {};
        const fiber = yield* Effect.forkIn(
          download(subscription).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (downloading?.fiber === fiberOf.get(token)) downloading = null;
              }),
            ),
          ),
          scope,
        );
        fiberOf.set(token, fiber);
        running = { key: subscription.key, fiber };
        downloading = running;
      }
      yield* Fiber.join(running.fiber);
    });

    const refreshIfStale = Effect.gen(function* () {
      const subscription = yield* source.current;
      // Known to have none: asking again every check would only read the playlist over and over.
      if (subscription && absent === subscription.key) return;
      const guide = yield* current;
      const now = yield* Clock.currentTimeMillis;
      if (guide && now - guide.fetchedAt < MAX_AGE_MS) return;
      yield* refresh;
    });

    // Checks now and then; the app asks for the first download itself, after its own start.
    yield* Effect.forkScoped(
      refreshIfStale.pipe(
        Effect.catchTag("Failed", (failure) =>
          Effect.logWarning("[guide] refresh failed", failure.error),
        ),
        Effect.catchDefect((defect) => Effect.logWarning("[guide] refresh failed", defect)),
        Effect.delay(CHECK_EVERY),
        Effect.forever,
      ),
    );

    /** The loaded guide with the catalogue's channels and the time, or null without either. */
    const context = Effect.gen(function* () {
      const guide = yield* current;
      if (!guide) return null;
      const channels = yield* catalogue.channels.pipe(
        Effect.catchTag("Failed", () => Effect.succeed(null)),
      );
      if (!channels) return null;
      return { guide, channels, at: yield* Clock.currentTimeMillis };
    });

    return {
      listings: (channelIds: readonly string[]) =>
        context.pipe(
          Effect.map((found): Record<string, Listing> =>
            found ? listingsAt(found.guide, found.channels, channelIds, found.at) : {},
          ),
        ),
      schedule: (channelId: string) =>
        context.pipe(
          Effect.map((found): readonly Programme[] =>
            found ? scheduleAt(found.guide, found.channels, channelId, found.at) : [],
          ),
        ),
      search: (query: string) =>
        context.pipe(
          Effect.map((found): readonly ProgrammeMatch[] =>
            found ? searchAt(found.guide, found.channels, query, found.at) : [],
          ),
        ),
      searchChannels: (query: string, channelIds: readonly string[], until: number) =>
        context.pipe(
          Effect.map((found): Record<string, ListingMatch> =>
            found
              ? searchChannelsAt(found.guide, found.channels, channelIds, query, found.at, until)
              : {},
          ),
        ),
      status: Effect.gen(function* () {
        const subscription = yield* source.current;
        if (subscription && absent === subscription.key) return statusOf(null, 0, "none");
        const found = yield* context;
        if (found) {
          return statusOf(found.guide, channelsCovered(found.guide, found.channels), "available");
        }
        // Loaded, but the catalogue it is counted against isn't.
        const guide = yield* current;
        return statusOf(guide, 0, guide ? "available" : "unknown");
      }),
      refresh,
      refreshIfStale,
      clear: Effect.gen(function* () {
        generation++;
        loaded = null;
        absent = null;
        const running = downloading;
        downloading = null;
        if (running) yield* Fiber.interrupt(running.fiber);
        yield* store.clear;
      }),
      changes: Stream.fromPubSub(updates),
    };
  });
}

function statusOf(
  guide: Loaded | null,
  channels: number,
  availability: GuideStatus["availability"],
): GuideStatus {
  return { channels, fetchedAt: guide?.fetchedAt ?? null, availability };
}

/** Passes the download on while saving it, as it came, to `draft`. */
async function* saving(
  body: ReadableStream<Uint8Array>,
  draft: GuideDraft,
): AsyncGenerator<Uint8Array> {
  for await (const bytes of body) {
    await draft.write(bytes);
    yield bytes;
  }
}
