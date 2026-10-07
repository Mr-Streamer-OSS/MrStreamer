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
// A subscription's guide is its own, its provider's or the one its playlist names, until the
// viewer gives it an XMLTV address of its own. That is checked first: `check` downloads and reads
// it while the guide in use stays as it is, and `use` switches to what the check found, only
// while that check is still the latest and nothing changed underneath it. From then on that
// address is the subscription's guide, also when it can't be reached: the last download that
// worked stays, the status says why the latest failed, and nothing goes back to the own guide
// until `restore` is asked for. The address can hold a key, so it is kept sealed and only its
// origin is ever told.
//
// A channel shows the guide channel its own guide id names, or the one the viewer mapped it to
// (`map`), which then counts alone. Mappings are made against one guide: another address, or the
// own guide again, starts without them; the same address entered again keeps them.
//
// A subscription can answer that it has no guide, as a playlist does whose first line names none.
// That is an answer like any other: a guide loaded before is dropped, the status says so, and the
// service doesn't ask again on its own until the app starts again. Only a refresh the viewer asks
// for does. Until a subscription has answered, whether it has a guide is unknown.
//
// The app supplies the ports: the subscriptions and their downloads, each catalogue's channels,
// a store for the documents and for what is set, and the addresses' keychain and network.
// Downloads and checks run in the service's scope, so `forget` and shutdown stop them. Whatever
// work finishes late changes nothing: not after its subscription went, not under a login that
// changed since, and not once the guide's source did. Each write is checked for that when its
// turn at the files comes, so one that waited can't bring back what was removed meanwhile. A
// mapping reads the channels and the guide in that turn too, so it is made for none that either
// stopped listing while it waited. One subscription's guide failing leaves every other as it is.
import { randomUUID } from "node:crypto";
import type { AppError } from "@mrstreamer/contracts/errors";
import type {
  GuideCandidate,
  GuideChannelPage,
  GuideFailure,
  GuideStatus,
  Listing,
  ListingMatch,
  MapChannel,
  MapChannelPage,
  MapFilter,
  Programme,
  ProgrammeMatch,
} from "@mrstreamer/contracts/guide";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import * as Cause from "effect/Cause";
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
import { guideAddress, type GuideAddress } from "./address.ts";
import { xmltvDocument } from "./document.ts";
import { GUIDE_LIMITS } from "./limits.ts";
import {
  channelsCovered,
  guideChannelsAt,
  indexProgrammes,
  listingsAt,
  mapChannel,
  mapChannelsAt,
  mappedChannels,
  scheduleAt,
  searchAt,
  searchChannelsAt,
  SEARCH_LIMIT,
  unresolvedMappings,
  type CatalogueChannels,
  type GuideMapping,
  type MappedChannels,
  type ProgrammeIndex,
} from "./programmes.ts";

/** A guide older than this is downloaded again. Providers cover about a day ahead. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** How often the service checks whether the guides are due. */
const CHECK_EVERY = "15 minutes";
/** How many guides download at a time, checks of an address among them. */
const DOWNLOADS_AT_ONCE = 2;

/** A subscription whose guide to keep: its identity and its own XMLTV download. */
export interface GuideSubscription {
  /** What its channels name it by. */
  readonly id: string;
  /** Rises when its login or link changes: what began before doesn't count after. */
  readonly revision: number;
  /** The account its guide, and what is set for it, are kept for. */
  readonly key: string;
  /** Where the store keeps them, as the store names it: the app gives a folder. */
  readonly store: string;
  /**
   * Asks the subscription for its own guide now: the document, or that it has none. Null while
   * its password or link can't be read: the guide it loaded before still shows, and none
   * downloads.
   */
  readonly download: ((signal: AbortSignal) => Promise<LiveGuide>) | null;
}

/** Which subscriptions are saved, in their order. */
export class GuideSource extends Context.Service<
  GuideSource,
  { readonly saved: Effect.Effect<readonly GuideSubscription[]> }
>()("mrstreamer/GuideSource") {}

/** A subscription's catalogue: its channels as the lists show them, with their guide ids. */
export class GuideCatalogue extends Context.Service<
  GuideCatalogue,
  {
    /**
     * The same object while the catalogue and what the lists show of it are the same, so what
     * is worked out from it can be kept.
     */
    readonly channels: (subscriptionId: string) => Effect.Effect<CatalogueChannels, Failed>;
  }
>()("mrstreamer/GuideCatalogue") {}

/** An own guide's document being saved as it downloads. Nothing replaces the saved one until `commit`. */
export interface GuideDraft {
  write(bytes: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  discard(): Promise<void>;
}

/**
 * An external guide's document being saved as it downloads, in a file of its own. It becomes
 * the subscription's guide only once what is set names `file`.
 */
export interface GuideDocumentDraft {
  /** What the store names the document by. */
  readonly file: string;
  write(bytes: Uint8Array): Promise<void>;
  /** Ends the document. It stays until it is discarded. */
  close(): Promise<void>;
  discard(): Promise<void>;
}

/** Where a subscription's guide is kept: `GuideSubscription.store`, and whose it is. */
export type GuidePlace = Pick<GuideSubscription, "store" | "key">;

/** An XMLTV address the viewer gave a subscription for its guide, as it is kept. */
export interface ExternalGuide {
  /** Its scheme, host and port: all of the address that isn't sealed. */
  readonly origin: string;
  /** Tells addresses apart without holding one (`GuideAddress.identity`). */
  readonly identity: string;
  readonly sealedAddress: string;
  /** Epoch milliseconds since it is the subscription's guide. */
  readonly since: number;
  /** Its last download that worked: the document, and when it arrived. */
  readonly document: { readonly file: string; readonly fetchedAt: number };
  /** Why its downloads fail, and since when, until one works. */
  readonly failure: { readonly at: number; readonly error: AppError } | null;
}

/** What the viewer set for a subscription's guide. */
export interface GuideConfig {
  /** The address in use in place of its own guide, or null for its own. */
  readonly external: ExternalGuide | null;
  /** The channels mapped by hand, by channel id, for the guide in use. */
  readonly mappings: Readonly<Record<string, GuideMapping>>;
}

const NOTHING_SET: GuideConfig = { external: null, mappings: {} };

/**
 * Where each subscription's guide is kept, for the next start. An own guide stays where every
 * release keeps it. What is set for a guide, and an external guide's documents, are kept beside
 * it, where older releases don't look: going back to one shows the own guide again, and never
 * another guide's programmes under its name.
 */
export class GuideStore extends Context.Service<
  GuideStore,
  {
    /** The own guide's document saved at `place` for its account and when it was downloaded, or null. */
    readonly read: (
      place: GuidePlace,
    ) => Effect.Effect<{ fetchedAt: number; document: AsyncIterable<Uint8Array> } | null>;
    readonly save: (place: GuidePlace, fetchedAt: number) => Effect.Effect<GuideDraft, Failed>;
    /** Drops the own guide's document. */
    readonly clear: (place: Pick<GuidePlace, "store">) => Effect.Effect<void>;
    /** What is set for the account at `place`, or null when nothing is. */
    readonly config: (place: GuidePlace) => Effect.Effect<GuideConfig | null>;
    /**
     * Keeps what is set, whole or not at all: an interrupted write leaves what was set before.
     * It never makes the subscription's folder, so one that went is not brought back.
     */
    readonly setConfig: (place: GuidePlace, config: GuideConfig) => Effect.Effect<void, Failed>;
    readonly draft: (place: GuidePlace) => Effect.Effect<GuideDocumentDraft, Failed>;
    /** An external guide's document by its `file`. Reading it fails when it is gone. */
    readonly document: (place: GuidePlace, file: string) => AsyncIterable<Uint8Array>;
    readonly discard: (place: Pick<GuidePlace, "store">, file: string) => Effect.Effect<void>;
    /** Drops every external document but `keep`: what work cut short left behind. */
    readonly sweep: (place: Pick<GuidePlace, "store">, keep: string | null) => Effect.Effect<void>;
    /** Drops everything kept of a guide: its documents, and what was set for it. */
    readonly erase: (place: Pick<GuidePlace, "store">) => Effect.Effect<void>;
  }
>()("mrstreamer/GuideStore") {}

/** The keychain and the network, for the addresses viewers give. */
export class GuideAddresses extends Context.Service<
  GuideAddresses,
  {
    readonly seal: (address: string) => Effect.Effect<string, Failed>;
    /** The address, or null when the keychain no longer opens it. */
    readonly open: (sealed: string) => Effect.Effect<string | null>;
    /**
     * Requests the document at an address, as it downloads. It carries nothing of a provider's
     * login, and fails naming no more of the address than its origin.
     */
    readonly fetch: (address: string, signal: AbortSignal) => Promise<AsyncIterable<Uint8Array>>;
  }
>()("mrstreamer/GuideAddresses") {}

interface Loaded extends ProgrammeIndex {
  /** The subscription it is the guide of. */
  readonly subscriptionId: string;
  readonly fetchedAt: number;
}

/** What is set for a subscription's guide, as read this run. */
interface Settings {
  readonly key: string;
  readonly config: GuideConfig;
  /** The external address itself; null for an own guide, and while the keychain won't open it. */
  readonly address: string | null;
}

/** What a check found, until it is used or dropped. Its document waits in the store. */
interface Candidate {
  readonly id: string;
  /** The subscription as it was saved when the check began. */
  readonly subscription: GuideSubscription;
  readonly generation: number;
  readonly address: GuideAddress;
  readonly file: string;
  readonly fetchedAt: number;
}

/** A loaded guide, its subscription's channels and the time: what a lookup reads. */
interface Found {
  readonly guide: Loaded;
  readonly channels: MappedChannels;
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
     * For each saved subscription, in their order: where its guide comes from, how many channels
     * it covers and since when, why its latest download failed, or that the subscription has none.
     */
    readonly status: Effect.Effect<readonly GuideStatus[]>;
    /**
     * Downloads a subscription's guide from where it comes: its own, or the address set for it.
     * Concurrent calls for one subscription share a download; a failure keeps the guide. An own
     * guide that answers it has none succeeds, and a guide loaded before goes.
     */
    refresh(subscriptionId: string): Effect.Effect<void, Failed>;
    /**
     * Downloads a subscription's guide when there is none or it is six hours old. A subscription
     * that answered it has none isn't asked again.
     */
    refreshIfStale(subscriptionId: string): Effect.Effect<void, Failed>;
    /**
     * Downloads and reads the XMLTV guide at the address typed, or the one in use when nothing
     * was, and says what it lists. Nothing changes: the guide in use stays, and what was found
     * waits for `use`. A subscription has one check at a time: a later one stops this, which then
     * fails with `cancelled`.
     */
    check(subscriptionId: string, typed: string): Effect.Effect<GuideCandidate, Failed>;
    /** Stops a subscription's check and drops what one found. */
    cancelCheck(subscriptionId: string): Effect.Effect<void>;
    /**
     * Makes what a check found the subscription's guide. Fails with `changed`, switching nothing,
     * unless that check is the latest and the subscription is as it was then.
     */
    use(subscriptionId: string, candidateId: string): Effect.Effect<GuideStatus, Failed>;
    /**
     * Goes back to the subscription's own guide and drops the address, with what it downloaded
     * and the mappings made against it. The own guide loads from what was kept of it, or is
     * asked for; one that can't be had says why in the status answered.
     */
    restore(subscriptionId: string): Effect.Effect<GuideStatus, Failed>;
    /**
     * Maps a channel to the guide channel `guideId` names exactly, or back to automatic with
     * null. `revision` names the guide the choice was made from: another one refuses it, and so
     * does a channel the provider, or a guide channel the guide, no longer lists once the
     * mapping is written.
     */
    map(
      subscriptionId: string,
      channelId: string,
      guideId: string | null,
      revision: string,
    ): Effect.Effect<MapChannel | null, Failed>;
    /** A page of a subscription's channels with how each gets its programmes. */
    mapChannels(query: {
      readonly subscriptionId: string;
      readonly filter: MapFilter;
      readonly query: string;
      readonly offset: number;
      readonly limit: number;
    }): Effect.Effect<MapChannelPage, Failed>;
    /** A page of the channels a subscription's guide lists. */
    mapOptions(query: {
      readonly subscriptionId: string;
      readonly query: string;
      readonly offset: number;
      readonly limit: number;
    }): Effect.Effect<GuideChannelPage, Failed>;
    /**
     * Forgets everything of a subscription's guide and stops its work, for when the subscription
     * goes.
     */
    forget(subscription: Pick<GuideSubscription, "id" | "store">): Effect.Effect<void>;
    /**
     * Emits whenever a guide is loaded or dropped, what is set for one changes, or a download
     * fails.
     */
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
    const addresses = yield* GuideAddresses;
    const scope = yield* Effect.scope;
    const updates = yield* PubSub.unbounded<void>();
    const loadOne = yield* Semaphore.make(1);
    const downloadOne = (yield* Semaphore.make(DOWNLOADS_AT_ONCE)).withPermits(1);
    /** What is set for the guides is read and changed one at a time. */
    const setOne = (yield* Semaphore.make(1)).withPermits(1);

    /** Each subscription's guide, by its id. */
    const loaded = new Map<string, Loaded>();
    /** The subscriptions that answered they have no guide, by id, until they answer otherwise. */
    const absent = new Set<string>();
    /** The subscriptions with no saved document this run could read: none is read for them again. */
    const unread = new Set<string>();
    /** What is set for each subscription's guide, by its id, once read. */
    const settings = new Map<string, Settings>();
    /** Why a subscription's downloads fail, and since when, until one works. */
    const failures = new Map<string, { readonly error: AppError; readonly at: number }>();
    /** A subscription's channels with its mappings over them, while both are the same. */
    const overlays = new Map<
      string,
      {
        readonly base: CatalogueChannels;
        readonly mappings: GuideConfig["mappings"];
        readonly channels: MappedChannels;
      }
    >();
    /**
     * Rises, per subscription, whenever its guide becomes another's: its source changes, or
     * `forget` drops it. Work that started before doesn't apply its result.
     */
    const generations = new Map<string, number>();
    const generationOf = (id: string) => generations.get(id) ?? 0;
    const downloading = new Map<
      string,
      {
        readonly subscription: GuideSubscription;
        readonly generation: number;
        readonly token: object;
        readonly fiber: Fiber.Fiber<void, Failed>;
      }
    >();
    /** Each subscription's check in progress, and what its last one found. */
    const checking = new Map<
      string,
      { readonly token: object; readonly fiber: Fiber.Fiber<GuideCandidate, Failed> }
    >();
    const candidates = new Map<string, Candidate>();
    const noSubscription = new Failed({ error: { kind: "no-subscription" } });
    const failed = (failure: GuideFailure) => new Failed({ error: { kind: "guide", failure } });
    const changed = failed({ kind: "changed" });
    const published = PubSub.publish(updates, undefined);

    /** Whether `other` is `subscription` with the login or link it had then. */
    const same = (subscription: GuideSubscription, other: GuideSubscription | null | undefined) =>
      other?.id === subscription.id && other.revision === subscription.revision;

    const savedAs = (subscriptionId: string) =>
      Effect.map(source.saved, (saved) => saved.find((each) => each.id === subscriptionId) ?? null);

    /** The saved subscription `subscriptionId` names, or `no-subscription`. */
    const savedOr = (subscriptionId: string) =>
      Effect.flatMap(savedAs(subscriptionId), (subscription) =>
        subscription ? Effect.succeed(subscription) : Effect.fail(noSubscription),
      );

    /** Names the guide a list of channels was read from, for a change made from that list. */
    const revisionOf = ({ id, revision }: GuideSubscription) => `${revision}.${generationOf(id)}`;

    /** What is set for a subscription's guide: from memory, or read once from the store. */
    const settingsOf = (subscription: GuideSubscription) =>
      Effect.suspend(() => {
        const kept = settings.get(subscription.id);
        return kept?.key === subscription.key
          ? Effect.succeed(kept)
          : setOne(readSettings(subscription));
      });

    /** Only runs in `setOne`. */
    const readSettings = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const { id, key } = subscription;
        const kept = settings.get(id);
        if (kept?.key === key) return kept;
        const started = generationOf(id);
        const stored = yield* store
          .config(subscription)
          .pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning("[guide] can't read what is set for the guide", defect).pipe(
                Effect.as(null),
              ),
            ),
          );
        const config = stored ?? NOTHING_SET;
        const address = config.external
          ? yield* addresses.open(config.external.sealedAddress)
          : null;
        // What a check or a download cut short left behind: none of this run's is there yet.
        yield* store.sweep(subscription, config.external?.document.file ?? null);
        const read: Settings = { key, config, address };
        // Forgotten while it was read: nothing is kept of it.
        if (generationOf(id) !== started) return read;
        settings.set(id, read);
        if (config.external?.failure) failures.set(id, config.external.failure);
        return read;
      });

    /**
     * Changes what is set for a subscription's guide, when the change's turn at the files comes
     * and only while it still applies: the subscription is saved with the login it had, and its
     * guide's source is the one `started` names. `next` gives what to set from what is set then,
     * or null to leave it. It runs in that turn, so what it reads there is as the change finds
     * it, whatever arrived while it waited; it reads nothing that is set, which would wait for
     * this same turn. `applied` runs once the change is kept, before anything else has a turn.
     * Answers what was set before, or null when nothing changed. A change that began can't be
     * stopped halfway.
     */
    const change = (
      subscription: GuideSubscription,
      started: number,
      next: (now: Settings) => Effect.Effect<Settings | null, Failed>,
      applied: () => void = () => {},
    ) =>
      setOne(
        Effect.gen(function* () {
          const { id } = subscription;
          if (generationOf(id) !== started || !same(subscription, yield* savedAs(id))) return null;
          const now = yield* readSettings(subscription);
          const then = yield* next(now);
          if (!then) return null;
          if (then.config !== now.config) yield* store.setConfig(subscription, then.config);
          settings.set(id, then);
          applied();
          return now;
        }),
      ).pipe(Effect.uninterruptible);

    /** A subscription's guide becomes another's: what was loaded and known of it goes. */
    const turned = (id: string) => {
      generations.set(id, generationOf(id) + 1);
      loaded.delete(id);
      absent.delete(id);
      unread.delete(id);
      failures.delete(id);
    };

    /** A saved subscription's guide: from memory, or read from the store once. */
    const current = (subscription: GuideSubscription) =>
      Effect.suspend(() => {
        const { id } = subscription;
        // Nothing is kept for a subscription without a guide, so there is nothing to read.
        if (absent.has(id) || unread.has(id)) return Effect.succeed(null);
        const kept = loaded.get(id);
        return kept ? Effect.succeed(kept) : loadOne.withPermits(1)(readStored(subscription));
      });

    const readStored = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const kept = loaded.get(id);
        if (kept) return kept;
        const { config } = yield* settingsOf(subscription);
        const started = generationOf(id);
        const saved = config.external
          ? {
              fetchedAt: config.external.document.fetchedAt,
              document: store.document(subscription, config.external.document.file),
            }
          : yield* store
              .read(subscription)
              .pipe(
                Effect.catchDefect((defect) =>
                  Effect.logWarning("[guide] can't read the guide on disk", defect).pipe(
                    Effect.as(null),
                  ),
                ),
              );
        const since = yield* Clock.currentTimeMillis;
        const index = !saved
          ? null
          : yield* Effect.tryPromise({
              try: () => indexProgrammes(saved.document, since),
              catch: failedWith,
            }).pipe(
              Effect.catchTag("Failed", (failure) =>
                Effect.logWarning("[guide] ignoring the guide on disk", failure.error).pipe(
                  Effect.as(null),
                ),
              ),
            );
        // Its source changed, it was dropped or it answered it has none, while it was read.
        if (generationOf(id) !== started || absent.has(id)) return null;
        const downloaded = loaded.get(id);
        if (downloaded) return downloaded;
        if (!saved || !index) {
          unread.add(id);
          return null;
        }
        const guide: Loaded = { subscriptionId: id, fetchedAt: saved.fetchedAt, ...index };
        loaded.set(id, guide);
        return guide;
      });

    /**
     * Notes why a download failed, for the status: since when is the first failure after the
     * last download that worked. An external guide's is kept with what is set for it, so it
     * shows after a restart too.
     */
    const noteFailure = (subscription: GuideSubscription, started: number, error: AppError) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const failure = {
          at: failures.get(id)?.at ?? (yield* Clock.currentTimeMillis),
          error,
        };
        const stands = yield* change(
          subscription,
          started,
          (now) =>
            Effect.succeed(
              now.config.external
                ? {
                    ...now,
                    config: { ...now.config, external: { ...now.config.external, failure } },
                  }
                : now,
            ),
          () => failures.set(id, failure),
          // What can't be written still shows this run.
        ).pipe(Effect.catchTag("Failed", () => Effect.succeed(null)));
        if (stands) yield* published;
      });

    /**
     * Asks the subscription for its own guide and downloads it, saving as it arrives; the new
     * guide replaces the old only once complete, and only while its answer still counts. A
     * subscription that has none leaves none behind, in memory or on disk.
     */
    const downloadOwn = (
      subscription: GuideSubscription,
      ask: NonNullable<GuideSubscription["download"]>,
      started: number,
    ) =>
      Effect.gen(function* () {
        const { id } = subscription;
        /** Whether the answer still counts: its guide is still this one, under the same login. */
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
                  : indexProgrammes(
                      saving(xmltvDocument(guide.body, GUIDE_LIMITS.bytes), draft),
                      fetchedAt,
                    );
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
        failures.delete(id);
        if (index === null) {
          const known = absent.has(id);
          absent.add(id);
          // Asked again and still none: nothing changed, so nothing is told.
          if (known) return;
          // A guide loaded before is the one the subscription had before.
          loaded.delete(id);
          yield* store.clear(subscription);
          yield* published;
          return;
        }
        absent.delete(id);
        unread.delete(id);
        loaded.set(id, { subscriptionId: id, fetchedAt, ...index });
        yield* published;
      });

    /**
     * Downloads the guide at the address set for a subscription, into a document of its own.
     * It becomes the guide, and the one before goes, only once it is read whole and what is set
     * names it. Until then, and when it fails, the last one stays as it is.
     */
    const downloadExternal = (
      subscription: GuideSubscription,
      external: ExternalGuide,
      address: string,
      started: number,
    ) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const fetchedAt = yield* Clock.currentTimeMillis;
        const draft = yield* store.draft(subscription);
        let kept = false;
        yield* Effect.gen(function* () {
          const index = yield* reading(address, draft, fetchedAt);
          const before = yield* change(
            subscription,
            started,
            (now) =>
              Effect.succeed(
                now.config.external?.identity === external.identity
                  ? {
                      ...now,
                      config: {
                        ...now.config,
                        external: {
                          ...now.config.external,
                          document: { file: draft.file, fetchedAt },
                          failure: null,
                        },
                      },
                    }
                  : null,
              ),
            () => {
              kept = true;
              failures.delete(id);
              unread.delete(id);
              loaded.set(id, { subscriptionId: id, fetchedAt, ...index });
            },
          );
          if (!before?.config.external) return;
          yield* store.discard(subscription, before.config.external.document.file);
          yield* published;
        }).pipe(Effect.onExit(() => (kept ? Effect.void : Effect.promise(() => draft.discard()))));
      });

    /**
     * Downloads the document at `address` into `draft` and indexes it as of `since`, as one
     * the viewer chose: whole, XMLTV, and with a programme still to come.
     */
    const reading = (address: string, draft: GuideDocumentDraft, since: number) =>
      Effect.tryPromise({
        try: async (signal) => {
          const index = await indexProgrammes(
            saving(
              xmltvDocument(await addresses.fetch(address, signal), GUIDE_LIMITS.bytes),
              draft,
            ),
            since,
            { strict: true },
          );
          await draft.close();
          return index;
        },
        catch: failedWith,
      });

    /** Downloads a subscription's guide from where it comes now. */
    const download = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const { config, address } = yield* settingsOf(subscription);
        const started = generationOf(subscription.id);
        const { external } = config;
        const run = external
          ? address === null
            ? Effect.fail(failed({ kind: "locked" }))
            : downloadExternal(subscription, external, address, started)
          : subscription.download
            ? downloadOwn(subscription, subscription.download, started)
            : Effect.fail(needsSecret(subscription));
        yield* run.pipe(
          Effect.tapError((failure) => noteFailure(subscription, started, failure.error)),
        );
      }).pipe(downloadOne, diagnosed("guide"));

    /** Whether a subscription's guide can be asked for now: its login or its address is at hand. */
    const reachable = (subscription: GuideSubscription) =>
      Effect.map(settingsOf(subscription), ({ config, address }) =>
        config.external ? address !== null : subscription.download !== null,
      );

    /** Waits for work a change to the guide can stop, which then fails with `stopped`. */
    const joined = <A>(fiber: Fiber.Fiber<A, Failed>, stopped: GuideFailure) =>
      Effect.flatMap(Fiber.await(fiber), (exit) =>
        Exit.isSuccess(exit)
          ? Effect.succeed(exit.value)
          : Cause.hasInterrupts(exit.cause)
            ? Effect.fail(failed(stopped))
            : Effect.failCause(exit.cause),
      );

    const refreshOf = (subscription: GuideSubscription): Effect.Effect<void, Failed> =>
      Effect.gen(function* () {
        const { id } = subscription;
        if (!(yield* reachable(subscription))) {
          const { config } = yield* settingsOf(subscription);
          return yield* config.external ? failed({ kind: "locked" }) : needsSecret(subscription);
        }
        const generation = generationOf(id);
        const under = downloading.get(id);
        let running =
          under && same(subscription, under.subscription) && under.generation === generation
            ? under
            : null;
        if (!running) {
          const token = {};
          const fiber = yield* Effect.forkIn(
            download(subscription).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (downloading.get(id)?.token === token) downloading.delete(id);
                }),
              ),
            ),
            scope,
          );
          running = { subscription, generation, token, fiber };
          downloading.set(id, running);
        }
        yield* joined(running.fiber, { kind: "changed" });
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

    /** Stops a subscription's download, when one runs. */
    const stopDownload = (id: string) =>
      Effect.suspend(() => {
        const running = downloading.get(id);
        downloading.delete(id);
        return running ? Fiber.interrupt(running.fiber) : Effect.void;
      });

    /** Stops a subscription's check, and drops what its last one found. */
    const dropCandidate = (id: string) =>
      Effect.gen(function* () {
        const running = checking.get(id);
        checking.delete(id);
        if (running) yield* Fiber.interrupt(running.fiber);
        const candidate = candidates.get(id);
        candidates.delete(id);
        if (candidate) yield* store.discard(candidate.subscription, candidate.file);
      });

    /**
     * Downloads the guide at `address` and says what it found, changing nothing but the
     * subscription's candidate.
     */
    const checked = (subscription: GuideSubscription, address: GuideAddress, started: number) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const fetchedAt = yield* Clock.currentTimeMillis;
        const draft = yield* store.draft(subscription);
        let kept = false;
        return yield* Effect.gen(function* () {
          const index = yield* reading(address.href, draft, fetchedAt);
          const channels = yield* catalogue
            .channels(id)
            .pipe(Effect.catchTag("Failed", () => Effect.succeed(null)));
          const { config } = yield* settingsOf(subscription);
          if (generationOf(id) !== started || !same(subscription, yield* savedAs(id))) {
            return yield* changed;
          }
          const candidate: Candidate = {
            id: randomUUID(),
            subscription,
            generation: started,
            address,
            file: draft.file,
            fetchedAt,
          };
          candidates.set(id, candidate);
          kept = true;
          return {
            id: candidate.id,
            origin: address.origin,
            guideChannels: index.channels.size,
            // By the channels' own guide ids: what the guide covers before anything is mapped.
            matched: channels ? channelsCovered(index, channels) : 0,
            listed: channels?.all.length ?? 0,
            until: index.until ?? fetchedAt,
            sameSource: config.external?.identity === address.identity,
          } satisfies GuideCandidate;
        }).pipe(Effect.onExit(() => (kept ? Effect.void : Effect.promise(() => draft.discard()))));
      }).pipe(downloadOne, diagnosed("guide"));

    // Checks now and then; the app asks for the first downloads itself, after its own start.
    // Each subscription's check stands alone: one that fails holds no other back.
    yield* Effect.forkScoped(
      Effect.flatMap(source.saved, (saved) =>
        Effect.forEach(
          saved,
          (subscription) =>
            Effect.flatMap(reachable(subscription), (can) =>
              can ? staleOf(subscription) : Effect.void,
            ).pipe(
              Effect.catchTag("Failed", (failure) =>
                Effect.logWarning("[guide] refresh failed", failure.error),
              ),
              Effect.catchDefect((defect) => Effect.logWarning("[guide] refresh failed", defect)),
            ),
          { concurrency: "unbounded", discard: true },
        ),
      ).pipe(Effect.delay(CHECK_EVERY), Effect.forever),
    );

    /** A subscription's channels with its mappings over their guide ids, or null without a catalogue. */
    const channelsOf = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const { id } = subscription;
        const base = yield* catalogue
          .channels(id)
          .pipe(Effect.catchTag("Failed", () => Effect.succeed(null)));
        if (!base) return null;
        const { mappings } = (yield* settingsOf(subscription)).config;
        const kept = overlays.get(id);
        if (kept?.base === base && kept.mappings === mappings) return kept.channels;
        const channels = mappedChannels(base, mappings);
        overlays.set(id, { base, mappings, channels });
        return channels;
      });

    /** A subscription's loaded guide with its catalogue's channels and the time, or null. */
    const context = (subscription: GuideSubscription) =>
      Effect.gen(function* () {
        const guide = yield* current(subscription);
        if (!guide) return null;
        const channels = yield* channelsOf(subscription);
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
        const { config, address } = yield* settingsOf(subscription);
        const guide = yield* current(subscription);
        const channels = yield* channelsOf(subscription);
        const failure = failures.get(id);
        return {
          subscriptionId: id,
          source: config.external
            ? {
                kind: "external",
                origin: config.external.origin,
                since: config.external.since,
                locked: address === null,
              }
            : { kind: "own" },
          // Loaded, but the catalogue it is counted against isn't: none covered yet.
          channels: guide && channels ? channelsCovered(guide, channels) : 0,
          listed: channels?.all.length ?? 0,
          guideChannels: guide?.channels.size ?? 0,
          fetchedAt: guide?.fetchedAt ?? null,
          availability: absent.has(id) ? "none" : guide ? "available" : "unknown",
          mapped: Object.keys(config.mappings).length,
          unresolved: channels ? unresolvedMappings(guide, channels) : 0,
          failure: failure?.error ?? null,
          failedAt: failure?.at ?? null,
        } satisfies GuideStatus;
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
      refresh: (subscriptionId: string) => Effect.flatMap(savedOr(subscriptionId), refreshOf),
      refreshIfStale: (subscriptionId: string) => Effect.flatMap(savedOr(subscriptionId), staleOf),

      check: (subscriptionId: string, typed: string) =>
        Effect.gen(function* () {
          const subscription = yield* savedOr(subscriptionId);
          const { id } = subscription;
          const { config, address: inUse } = yield* settingsOf(subscription);
          // Nothing typed checks the address in use again.
          const again = typed.trim() === "" && config.external !== null;
          const address = guideAddress(again ? (inUse ?? "") : typed);
          if (!address) return yield* failed({ kind: again ? "locked" : "address" });
          yield* dropCandidate(id);
          const token = {};
          const fiber = yield* Effect.forkIn(
            checked(subscription, address, generationOf(id)).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (checking.get(id)?.token === token) checking.delete(id);
                }),
              ),
            ),
            scope,
          );
          checking.set(id, { token, fiber });
          return yield* joined(fiber, { kind: "cancelled" });
        }),

      cancelCheck: (subscriptionId: string) => dropCandidate(subscriptionId),

      use: (subscriptionId: string, candidateId: string) =>
        Effect.gen(function* () {
          const subscription = yield* savedOr(subscriptionId);
          const { id } = subscription;
          const candidate = candidates.get(id);
          if (candidate?.id !== candidateId) return yield* changed;
          const stands = () =>
            candidates.get(id) === candidate &&
            same(subscription, candidate.subscription) &&
            candidate.generation === generationOf(id);
          /** Drops the candidate, unless a later check already took its place. */
          const dropped = Effect.suspend(() =>
            candidates.get(id) === candidate ? dropCandidate(id) : Effect.void,
          );
          if (!stands()) return yield* Effect.andThen(dropped, changed);
          const { address, file, fetchedAt } = candidate;
          const now = yield* Clock.currentTimeMillis;
          // Read again as of now: what was still to come at the check may have ended since.
          const index = yield* Effect.tryPromise({
            try: () => indexProgrammes(store.document(subscription, file), now, { strict: true }),
            catch: failedWith,
          }).pipe(Effect.tapError(() => dropped));
          const sealedAddress = yield* addresses.seal(address.href);
          const before = yield* change(
            subscription,
            candidate.generation,
            (was) => {
              if (!stands()) return Effect.succeed(null);
              const previous = was.config.external;
              const sameSource = previous?.identity === address.identity;
              return Effect.succeed({
                key: was.key,
                address: address.href,
                config: {
                  external: {
                    origin: address.origin,
                    identity: address.identity,
                    sealedAddress,
                    since: previous && sameSource ? previous.since : now,
                    document: { file, fetchedAt },
                    failure: null,
                  },
                  // Made against the guide before: another address starts without them.
                  mappings: sameSource ? was.config.mappings : {},
                },
              });
            },
            () => {
              candidates.delete(id);
              turned(id);
              loaded.set(id, { subscriptionId: id, fetchedAt, ...index });
            },
          );
          if (!before) return yield* Effect.andThen(dropped, changed);
          yield* stopDownload(id);
          const replaced = before.config.external?.document.file;
          if (replaced !== undefined) yield* store.discard(subscription, replaced);
          yield* published;
          return yield* statusOf(subscription);
        }),

      restore: (subscriptionId: string) =>
        Effect.gen(function* () {
          const subscription = yield* savedOr(subscriptionId);
          const { id } = subscription;
          const before = yield* change(
            subscription,
            generationOf(id),
            (was) => Effect.succeed({ key: was.key, address: null, config: NOTHING_SET }),
            () => turned(id),
          );
          if (!before) return yield* changed;
          yield* dropCandidate(id);
          yield* stopDownload(id);
          const dropped = before.config.external?.document.file;
          if (dropped !== undefined) yield* store.discard(subscription, dropped);
          yield* published;
          // Its own guide: what was kept of it while that still holds, else asked for now. One
          // that can't be had says why in its status.
          yield* Effect.ignore(staleOf(subscription));
          return yield* statusOf(subscription);
        }),

      map: (subscriptionId: string, channelId: string, guideId: string | null, revision: string) =>
        Effect.gen(function* () {
          const subscription = yield* savedOr(subscriptionId);
          const { id } = subscription;
          const started = generationOf(id);
          // Loads the guide where this run hasn't yet: the change reads it from memory.
          const read = yield* current(subscription);
          if (!read || revision !== revisionOf(subscription)) return yield* changed;
          const before = yield* change(subscription, started, (was) =>
            Effect.gen(function* () {
              // The channels and the guide as they are now, in the change's turn: a channel list
              // or a download that arrived while it waited may list neither any more.
              const channels = yield* catalogue
                .channels(id)
                .pipe(Effect.catchTag("Failed", () => Effect.succeed(null)));
              const guide = loaded.get(id);
              if (!guide || !channels) return yield* changed;
              const channel = channels.channel(channelId);
              if (guideId !== null) {
                if (!channel) {
                  return yield* new Failed({ error: { kind: "channel-not-found", channelId } });
                }
                // Only a channel the guide lists, by its exact id.
                if (!guide.channels.has(guideId)) return yield* changed;
              }
              /** Whether a mapping is this channel's, under whichever of its streams' ids it was made. */
              const names = (key: string) =>
                key === channelId ||
                (channel !== undefined && channels.channel(key)?.id === channel.id);
              const others = Object.fromEntries(
                Object.entries(was.config.mappings).filter(([key]) => !names(key)),
              );
              const mappings =
                guideId === null || !channel
                  ? others
                  : { ...others, [channel.id]: { guideId, name: channel.title } };
              return { ...was, config: { ...was.config, mappings } };
            }),
          );
          if (!before) return yield* changed;
          yield* published;
          const after = yield* context(subscription);
          const listed = after?.channels.channel(channelId);
          return after && listed ? mapChannel(after.guide, after.channels, listed) : null;
        }),

      mapChannels: ({
        subscriptionId,
        offset,
        limit,
        ...list
      }: {
        readonly subscriptionId: string;
        readonly filter: MapFilter;
        readonly query: string;
        readonly offset: number;
        readonly limit: number;
      }) =>
        Effect.gen(function* () {
          const subscription = yield* savedOr(subscriptionId);
          // Named before the page is read: one read while the guide becomes another's names the
          // guide before, whichever it read, so a choice made from it is refused.
          const revision = revisionOf(subscription);
          const found = yield* context(subscription);
          const page = found
            ? mapChannelsAt(found.guide, found.channels, list, offset, limit)
            : { total: 0, channels: [] };
          return { ...page, revision };
        }),

      mapOptions: ({
        subscriptionId,
        query,
        offset,
        limit,
      }: {
        readonly subscriptionId: string;
        readonly query: string;
        readonly offset: number;
        readonly limit: number;
      }) =>
        Effect.gen(function* () {
          const guide = yield* current(yield* savedOr(subscriptionId));
          return guide ? guideChannelsAt(guide, query, offset, limit) : { total: 0, channels: [] };
        }),

      forget: (subscription: Pick<GuideSubscription, "id" | "store">) =>
        Effect.gen(function* () {
          const { id } = subscription;
          turned(id);
          overlays.delete(id);
          yield* stopDownload(id);
          yield* dropCandidate(id);
          // After whatever change still had its turn: nothing of it is left, and none comes later.
          yield* setOne(
            Effect.suspend(() => {
              settings.delete(id);
              return store.erase(subscription);
            }),
          );
        }),
      changes: Stream.fromPubSub(updates),
    };
  });
}

function needsSecret(subscription: GuideSubscription): Failed {
  return new Failed({ error: { kind: "needs-secret", subscriptionId: subscription.id } });
}

/** Passes the document on while saving it, as it is read, to `draft`. */
async function* saving(
  document: AsyncIterable<Uint8Array>,
  draft: Pick<GuideDraft, "write">,
): AsyncGenerator<Uint8Array> {
  for await (const bytes of document) {
    await draft.write(bytes);
    yield bytes;
  }
}
