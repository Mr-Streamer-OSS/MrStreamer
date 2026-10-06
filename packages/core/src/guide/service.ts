// The programme guide service. It keeps each saved subscription's guide in memory, reads it from
// the store after a restart, downloads it again when it is six hours old, and forgets it when its
// subscription goes. Browsing and playback never wait for it: lookups answer empty until a guide
// has loaded.
//
// Channels are asked for with the subscription they belong to, and answers name them the same
// way (`ownedKey`): a guide id means something only within the subscription whose guide lists it.
// So each subscription's channels show the programmes of its own guide, and two subscriptions
// that use the same guide id never share an answer. A search goes through every guide and is cut
// only once they are all in.
//
// A subscription can answer that it has no guide, as a playlist does whose first line names none.
// That is an answer like any other: a guide loaded before is dropped, the status says so, and the
// service doesn't ask again on its own until the app starts again. Only a refresh the viewer asks
// for does. Until a subscription has answered, whether it has a guide is unknown.
//
// The app supplies three ports: the subscriptions and their downloads, each catalogue's guide
// ids, and a store for each document as it arrived. Downloads run in the service's scope, so
// `forget` and shutdown stop them, and a load or download that finishes after its subscription
// went changes nothing. Nor does a download begun under a login that changed since: it is neither
// shown nor saved. One subscription's guide failing leaves every other as it is.
import type {
  GuideStatus,
  Listing,
  ListingMatch,
  Programme,
  ProgrammeMatch,
} from "@mrstreamer/contracts/guide";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
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
  SEARCH_LIMIT,
  type GuideChannels,
  type ProgrammeIndex,
} from "./programmes.ts";

/** A guide older than this is downloaded again. Providers cover about a day ahead. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** How often the service checks whether the guides are due. */
const CHECK_EVERY = "15 minutes";
/** How many subscriptions' guides download at a time. */
const DOWNLOADS_AT_ONCE = 2;

/** A subscription whose guide to keep: its identity and its XMLTV download. */
export interface GuideSubscription {
  /** What its channels name it by. */
  readonly id: string;
  /** Rises when its login or link changes: a download begun before doesn't count after. */
  readonly revision: number;
  /** The account the saved document is kept for. */
  readonly key: string;
  /** Where the store keeps its document, as the store names it: the app gives a folder. */
  readonly store: string;
  /**
   * Asks the subscription for its guide now: the document, or that it has none. Null while its
   * password or link can't be read: the guide it loaded before still shows, and none downloads.
   */
  readonly download: ((signal: AbortSignal) => Promise<LiveGuide>) | null;
}

/** Which subscriptions are saved, in their order. */
export class GuideSource extends Context.Service<
  GuideSource,
  { readonly saved: Effect.Effect<readonly GuideSubscription[]> }
>()("mrstreamer/GuideSource") {}

/** A subscription's catalogue: its channels by guide id. */
export class GuideCatalogue extends Context.Service<
  GuideCatalogue,
  { readonly channels: (subscriptionId: string) => Effect.Effect<GuideChannels, Failed> }
>()("mrstreamer/GuideCatalogue") {}

/** A document being saved as it downloads. Nothing replaces the saved one until `commit`. */
export interface GuideDraft {
  write(bytes: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

/** Where a subscription's document is kept: `GuideSubscription.store`, and whose it is. */
export type GuidePlace = Pick<GuideSubscription, "store" | "key">;

/** Where each subscription's last complete document is kept, for the next start. */
export class GuideStore extends Context.Service<
  GuideStore,
  {
    /** The document saved at `place` for its account and when it was downloaded, or null. */
    readonly read: (
      place: GuidePlace,
    ) => Effect.Effect<{ fetchedAt: number; document: AsyncIterable<Uint8Array> } | null>;
    readonly save: (place: GuidePlace, fetchedAt: number) => Effect.Effect<GuideDraft, Failed>;
    readonly clear: (place: Pick<GuidePlace, "store">) => Effect.Effect<void>;
  }
>()("mrstreamer/GuideStore") {}

interface Loaded extends ProgrammeIndex {
  /** The subscription it is the guide of. */
  readonly subscriptionId: string;
  readonly fetchedAt: number;
}

/** A loaded guide, its subscription's channels and the time: what a lookup reads. */
interface Found {
  readonly guide: Loaded;
  readonly channels: GuideChannels;
  readonly at: number;
}

export class Guide extends Context.Service<
  Guide,
  {
    /**
     * What each channel shows now and next, by its `ownedKey`. Channels without guide data are
     * left out.
     */
    listings(channels: readonly OwnedId[]): Effect.Effect<Record<string, Listing>>;
    /** The channel's programme on now and the rest the guide knows. */
    schedule(channel: OwnedId): Effect.Effect<readonly Programme[]>;
    /** Programmes on now or later whose title matches, in any guide, on now first. */
    search(query: string): Effect.Effect<readonly ProgrammeMatch[]>;
    /**
     * What a search finds in the programmes of the given channels, by each channel's `ownedKey`:
     * on now, and the first later one that starts before `until`. Every channel given is searched.
     */
    searchChannels(
      query: string,
      channels: readonly OwnedId[],
      until: number,
    ): Effect.Effect<Record<string, ListingMatch>>;
    /**
     * For each saved subscription, in their order: how many channels its loaded guide covers and
     * when it was downloaded, or that the subscription has none.
     */
    readonly status: Effect.Effect<readonly GuideStatus[]>;
    /**
     * Asks a subscription for its guide and downloads it. Concurrent calls for one subscription
     * share a download; a failure keeps the guide. A subscription that answers it has none
     * succeeds, and a guide loaded before goes.
     */
    refresh(subscriptionId: string): Effect.Effect<void, Failed>;
    /**
     * Downloads a subscription's guide when there is none or it is six hours old. A subscription
     * that answered it has none isn't asked again.
     */
    refreshIfStale(subscriptionId: string): Effect.Effect<void, Failed>;
    /** Forgets a subscription's guide and stops its download, for when the subscription goes. */
    forget(subscription: Pick<GuideSubscription, "id" | "store">): Effect.Effect<void>;
    /** Emits whenever a new guide is loaded, or one loaded was dropped. */
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
    const downloadOne = (yield* Semaphore.make(DOWNLOADS_AT_ONCE)).withPermits(1);

    /** Each subscription's guide, by its id. */
    const loaded = new Map<string, Loaded>();
    /** The subscriptions that answered they have no guide, by id, until they answer otherwise. */
    const absent = new Set<string>();
    /**
     * Rises, per subscription, whenever its guide is dropped, by `forget` or by a subscription
     * that has none any more, so work that started before it doesn't apply its result.
     */
    const generations = new Map<string, number>();
    const generationOf = (id: string) => generations.get(id) ?? 0;
    const downloading = new Map<
      string,
      {
        readonly subscription: GuideSubscription;
        readonly token: object;
        readonly fiber: Fiber.Fiber<void, Failed>;
      }
    >();
    const noSubscription = new Failed({ error: { kind: "no-subscription" } });

    /** Whether `other` is `subscription` with the login or link it had then. */
    const same = (subscription: GuideSubscription, other: GuideSubscription | null | undefined) =>
      other?.id === subscription.id && other.revision === subscription.revision;

    const savedAs = (subscriptionId: string) =>
      Effect.map(source.saved, (saved) => saved.find((each) => each.id === subscriptionId) ?? null);

    /** A saved subscription's guide: from memory, or read from the store once. */
    const current = (subscription: GuideSubscription) =>
      Effect.suspend(() => {
        // Nothing is kept for a subscription without a guide, so there is nothing to read.
        if (absent.has(subscription.id)) return Effect.succeed(null);
        const kept = loaded.get(subscription.id);
        return kept ? Effect.succeed(kept) : loadOne.withPermits(1)(readStored(subscription));
      });

    const readStored = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const kept = loaded.get(id);
        if (kept) return kept;
        const started = generationOf(id);
        const saved = yield* store
          .read(subscription)
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
        // Dropped, or downloaded anew, while it was read.
        if (!index || generationOf(id) !== started) return null;
        const downloaded = loaded.get(id);
        if (downloaded) return downloaded;
        const guide: Loaded = { subscriptionId: id, fetchedAt: saved.fetchedAt, ...index };
        loaded.set(id, guide);
        return guide;
      });

    /**
     * Asks for the guide and downloads it, saving as it arrives; the new guide replaces the old
     * only once complete, and only while its answer still counts. A subscription that has none
     * leaves none behind, in memory or on disk.
     */
    const download = (
      subscription: GuideSubscription,
      ask: NonNullable<GuideSubscription["download"]>,
    ) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const started = generationOf(id);
        /** Whether the answer still counts: the guide wasn't dropped since, nor the login changed. */
        const counts = Effect.map(
          savedAs(id),
          (now) => generationOf(id) === started && same(subscription, now),
        );
        const fetchedAt = yield* Clock.currentTimeMillis;
        // Asking and reading share one signal, so stopping the download stops either.
        const index = yield* Effect.acquireUseRelease(
          store.save(subscription, fetchedAt),
          (draft) =>
            Effect.tryPromise({
              try: async (signal) => {
                const guide = await ask(signal);
                return guide.kind === "none"
                  ? null
                  : indexProgrammes(saving(guide.body, draft), fetchedAt);
              },
              catch: failedWith,
            }),
          (draft, exit) =>
            Effect.gen(function* () {
              // Saved only when it is also the guide to show: the next start reads what is saved.
              const keep = Exit.isSuccess(exit) && exit.value !== null && (yield* counts);
              yield* Effect.promise(() => (keep ? draft.commit() : draft.discard()));
            }),
        );
        if (!(yield* counts)) return;
        if (index === null) {
          const known = absent.has(id);
          absent.add(id);
          // Asked again and still none: nothing changed, so nothing is told.
          if (known) return;
          // A guide loaded or being read from disk is the one the subscription had before.
          generations.set(id, started + 1);
          loaded.delete(id);
          yield* store.clear(subscription);
          yield* PubSub.publish(updates, undefined);
          return;
        }
        absent.delete(id);
        loaded.set(id, { subscriptionId: id, fetchedAt, ...index });
        yield* PubSub.publish(updates, undefined);
      }).pipe(downloadOne, diagnosed("guide"));

    const refreshOf = (subscription: GuideSubscription): Effect.Effect<void, Failed> =>
      Effect.gen(function* () {
        const ask = subscription.download;
        if (!ask) {
          return yield* new Failed({
            error: { kind: "needs-secret", subscriptionId: subscription.id },
          });
        }
        const under = downloading.get(subscription.id);
        let running = under && same(subscription, under.subscription) ? under : null;
        if (!running) {
          const token = {};
          const fiber = yield* Effect.forkIn(
            download(subscription, ask).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (downloading.get(subscription.id)?.token === token) {
                    downloading.delete(subscription.id);
                  }
                }),
              ),
            ),
            scope,
          );
          running = { subscription, token, fiber };
          downloading.set(subscription.id, running);
        }
        yield* Fiber.join(running.fiber);
      });

    const staleOf = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        // Known to have none: asking again every check would only read the playlist over and over.
        if (absent.has(subscription.id)) return;
        const guide = yield* current(subscription);
        const now = yield* Clock.currentTimeMillis;
        if (guide && now - guide.fetchedAt < MAX_AGE_MS) return;
        yield* refreshOf(subscription);
      });

    /** Runs `run` for the saved subscription `subscriptionId` names, or fails without it. */
    const forSaved = (
      subscriptionId: string,
      run: (subscription: GuideSubscription) => Effect.Effect<void, Failed>,
    ) =>
      Effect.flatMap(savedAs(subscriptionId), (subscription) =>
        subscription ? run(subscription) : Effect.fail(noSubscription),
      );

    // Checks now and then; the app asks for the first downloads itself, after its own start.
    // Each subscription's check stands alone: one that fails holds no other back.
    yield* Effect.forkScoped(
      Effect.flatMap(source.saved, (saved) =>
        Effect.forEach(
          saved.filter((each) => each.download !== null),
          (subscription) =>
            staleOf(subscription).pipe(
              Effect.catchTag("Failed", (failure) =>
                Effect.logWarning("[guide] refresh failed", failure.error),
              ),
              Effect.catchDefect((defect) => Effect.logWarning("[guide] refresh failed", defect)),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      ).pipe(Effect.delay(CHECK_EVERY), Effect.forever),
    );

    /** A subscription's loaded guide with its catalogue's channels and the time, or null. */
    const context = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const guide = yield* current(subscription);
        if (!guide) return null;
        const channels = yield* catalogue
          .channels(subscription.id)
          .pipe(Effect.catchTag("Failed", () => Effect.succeed(null)));
        if (!channels) return null;
        return { guide, channels, at: yield* Clock.currentTimeMillis } satisfies Found;
      });

    /**
     * What `lookup` answers per channel id, in each subscription's own guide, for those of
     * `channels` whose subscription is saved, by each channel's `ownedKey`.
     */
    const perChannel = <A>(
      channels: readonly OwnedId[],
      lookup: (found: Found, ids: readonly string[]) => Record<string, A>,
    ) =>
      Effect.gen(function* () {
        const asked = new Map<string, string[]>();
        for (const { subscriptionId, id } of channels) {
          const ids = asked.get(subscriptionId);
          if (ids) ids.push(id);
          else asked.set(subscriptionId, [id]);
        }
        const answers: Record<string, A> = {};
        for (const subscription of yield* source.saved) {
          const ids = asked.get(subscription.id);
          const found = ids && (yield* context(subscription));
          if (!ids || !found) continue;
          for (const [id, answer] of Object.entries(lookup(found, ids))) {
            answers[ownedKey({ subscriptionId: subscription.id, id })] = answer;
          }
        }
        return answers;
      });

    const statusOf = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const { id } = subscription;
        if (absent.has(id)) return status(id, null, 0, "none");
        const found = yield* context(subscription);
        if (found) {
          return status(id, found.guide, channelsCovered(found.guide, found.channels), "available");
        }
        // Loaded, but the catalogue it is counted against isn't.
        const guide = yield* current(subscription);
        return status(id, guide, 0, guide ? "available" : "unknown");
      });

    return {
      listings: (channels: readonly OwnedId[]) =>
        perChannel(channels, (found, ids) =>
          listingsAt(found.guide, found.channels, ids, found.at),
        ),
      schedule: (channel: OwnedId) =>
        Effect.gen(function* () {
          const subscription = yield* savedAs(channel.subscriptionId);
          const found = subscription && (yield* context(subscription));
          return found ? scheduleAt(found.guide, found.channels, channel.id, found.at) : [];
        }),
      search: (query: string) =>
        Effect.gen(function* () {
          const matches: ProgrammeMatch[] = [];
          let at = 0;
          for (const subscription of yield* source.saved) {
            const found = yield* context(subscription);
            if (!found) continue;
            at = found.at;
            // Each guide's own first fifty hold every one of the first fifty of them all.
            matches.push(...searchAt(found.guide, found.channels, query, found.at));
          }
          const onNow = (match: ProgrammeMatch) => (match.programme.start <= at ? 0 : 1);
          return matches
            .sort((a, b) => onNow(a) - onNow(b) || a.programme.start - b.programme.start)
            .slice(0, SEARCH_LIMIT);
        }),
      searchChannels: (query: string, channels: readonly OwnedId[], until: number) =>
        perChannel(channels, (found, ids) =>
          searchChannelsAt(found.guide, found.channels, ids, query, found.at, until),
        ),
      status: Effect.flatMap(source.saved, (saved) => Effect.forEach(saved, statusOf)),
      refresh: (subscriptionId: string) => forSaved(subscriptionId, refreshOf),
      refreshIfStale: (subscriptionId: string) => forSaved(subscriptionId, staleOf),
      forget: (subscription: Pick<GuideSubscription, "id" | "store">) =>
        Effect.gen(function* () {
          const { id } = subscription;
          generations.set(id, generationOf(id) + 1);
          loaded.delete(id);
          absent.delete(id);
          const running = downloading.get(id);
          downloading.delete(id);
          if (running) yield* Fiber.interrupt(running.fiber);
          yield* store.clear(subscription);
        }),
      changes: Stream.fromPubSub(updates),
    };
  });
}

function status(
  subscriptionId: string,
  guide: Loaded | null,
  channels: number,
  availability: GuideStatus["availability"],
): GuideStatus {
  return { subscriptionId, channels, fetchedAt: guide?.fetchedAt ?? null, availability };
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
