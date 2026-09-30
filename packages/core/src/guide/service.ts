// The programme guide service. It keeps the current subscription's guide in memory, reads it from
// the store after a restart, downloads it again when it is six hours old, and forgets it when the
// account changes. Browsing and playback never wait for it: lookups answer empty until a guide
// has loaded.
//
// The app supplies three ports: the subscription and its download, the catalogue's guide ids, and
// a store for the document as it arrived. Downloads run in the service's scope, so `clear` and
// shutdown stop them, and a load or download that finishes after a `clear` changes nothing.
import type { Listing, Programme, ProgrammeMatch } from "@mrstreamer/contracts/guide";
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
import {
  indexProgrammes,
  listingsAt,
  scheduleAt,
  searchAt,
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
  download(signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
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
    /** Downloads the guide. Concurrent calls share a download; a failure keeps the guide. */
    readonly refresh: Effect.Effect<void, Failed>;
    /** Downloads the guide when there is none or it is six hours old. */
    readonly refreshIfStale: Effect.Effect<void, Failed>;
    /** Forgets the guide and stops a download, for when the account changes or goes. */
    readonly clear: Effect.Effect<void>;
    /** Emits whenever a new guide is loaded. */
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
    /** Rises on every `clear`, so work that started before it doesn't apply its result. */
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
      if (!subscription) return null;
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

    /** Downloads, saving as it arrives; the new guide replaces the old only once complete. */
    const download = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const started = generation;
        const fetchedAt = yield* Clock.currentTimeMillis;
        const index = yield* Effect.acquireUseRelease(
          store.save(subscription.key, fetchedAt),
          (draft) =>
            Effect.tryPromise({
              try: async (signal) =>
                indexProgrammes(saving(await subscription.download(signal), draft), fetchedAt),
              catch: failedWith,
            }),
          (draft, exit) =>
            Effect.promise(async () => {
              const keep = Exit.isSuccess(exit) && generation === started;
              await (keep ? draft.commit() : draft.discard());
            }),
        );
        const now = yield* source.current;
        if (generation !== started || now?.key !== subscription.key) return;
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
      refresh,
      refreshIfStale,
      clear: Effect.gen(function* () {
        generation++;
        loaded = null;
        const running = downloading;
        downloading = null;
        if (running) yield* Fiber.interrupt(running.fiber);
        yield* store.clear;
      }),
      changes: Stream.fromPubSub(updates),
    };
  });
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
