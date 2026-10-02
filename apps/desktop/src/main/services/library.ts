// The live catalogue: fetched from the provider, cached on disk, queried by the UI over IPC.
import { join } from "node:path";
import { type } from "arktype";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { CatalogueStatus, Category, LiveChannel } from "@mrstreamer/contracts/library";
import { adultIn } from "@mrstreamer/core/adult";
import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import { liveChannels } from "@mrstreamer/core/catalogue/variants";
import { diagnosed } from "@mrstreamer/core/diagnostics";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import type { GuideChannels } from "@mrstreamer/core/guide/programmes";
import type { LiveCatalogue } from "@mrstreamer/core/provider";
import { normalize } from "@mrstreamer/core/text";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { readJsonFile, removeFile, writeJsonFile } from "../platform/json-file.ts";
import { Settings } from "./preferences.ts";
import { Subscriptions, type Source } from "./subscription.ts";

/** How many results a search returns. Enough to scroll, small enough to send per keystroke. */
const SEARCH_LIMIT = 200;
/**
 * A refresh that returns fewer than this share of the channels before counts as possibly
 * incomplete. It replaces the catalogue only when a second fetch confirms it.
 */
const SHRINK_CONFIRM_SHARE = 0.5;
const SHRINK_CONFIRM_DELAY: Duration.Input = "3 seconds";

// The cache stores the catalogue as the provider sent it, and display names are worked out on
// load, so improved naming rules apply without fetching again. The newest stable release reads it
// too (see docs/contributing/architecture.md), so fields are added without a new version: a file
// written before guide ids or the adult flag still loads, and counts as outdated.
const CachedCatalogue = type({
  version: "4",
  /** Which subscription produced this catalogue. */
  key: "string",
  fetchedAt: "number",
  categories: type({ id: "string", name: "string" }).array(),
  channels: type({
    id: "string",
    name: "string",
    number: "number | null",
    logoUrl: "string | null",
    categoryIds: "string[]",
    "guideId?": "string | null",
    "adult?": "boolean",
  }).array(),
}).pipe((file) => ({
  ...file,
  channels: file.channels.map((channel) => ({ ...channel, guideId: channel.guideId ?? null })),
  outdated: file.channels.some(
    (channel) => channel.guideId === undefined || channel.adult === undefined,
  ),
}));

/** What the disk cache holds. */
interface CatalogueFile extends LiveCatalogue {
  readonly version: 4;
  readonly key: string;
  readonly fetchedAt: number;
}

interface IndexedCatalogue {
  readonly key: string;
  readonly fetchedAt: number;
  /** Written by a version that didn't keep guide ids. */
  readonly outdated: boolean;
  readonly categories: readonly Category[];
  readonly channels: readonly LiveChannel[];
  /** Channels by their own id and each of their streams'. */
  readonly byId: ReadonlyMap<string, LiveChannel>;
  /** Channels per category id, in provider order. */
  readonly byCategory: ReadonlyMap<string, readonly LiveChannel[]>;
  /** Normalised names of every stream, index-aligned with `channels`. */
  readonly searchNames: readonly string[];
  readonly guide: GuideChannels;
}

export interface LibraryOptions {
  readonly dataDir: string;
  /** Waits before a confirming fetch. Tests make it instant. */
  readonly confirmDelay?: Duration.Input;
}

export class Library extends Context.Service<
  Library,
  {
    /** Fetches the catalogue from the provider. Concurrent calls for one subscription share a fetch. */
    readonly refresh: Effect.Effect<CatalogueStatus, Failed>;
    /** Whether the catalogue should be fetched again: missing, older than `maxAge`, or outdated. */
    isStale(maxAge: Duration.Input): Effect.Effect<boolean>;
    /** The channels of the current catalogue by guide id, for the programme guide. */
    readonly guideChannels: Effect.Effect<GuideChannels, Failed>;
    readonly status: Effect.Effect<CatalogueStatus>;
    readonly categories: Effect.Effect<readonly Category[], Failed>;
    /**
     * All channels in a category, the best matches for a query across the catalogue, or the
     * channels with the given ids in that order. An id may be any of a channel's streams'; a
     * channel shows once.
     */
    channels(filter: {
      readonly categoryId?: string;
      readonly query?: string;
      readonly ids?: readonly string[];
    }): Effect.Effect<readonly LiveChannel[], Failed>;
    /** The channel by its id or any of its streams'. */
    channel(channelId: string): Effect.Effect<LiveChannel, Failed>;
    /**
     * Finds channels by their id or any of their streams', in the catalogue in memory or on disk.
     * Never fetches one: before the first, it finds none.
     */
    readonly lookup: Effect.Effect<(channelId: string) => LiveChannel | undefined>;
    /** Forgets the cached catalogue, for when the subscription changes or goes. */
    readonly clear: Effect.Effect<void>;
    /** The status after every refresh, successful or not. */
    readonly changes: Stream.Stream<CatalogueStatus>;
  }
>()("mrstreamer/Library") {
  static readonly layer = (options: LibraryOptions) => Layer.effect(Library, make(options));
}

function make(options: LibraryOptions) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const settings = yield* Settings;
    const scope = yield* Effect.scope;
    const updates = yield* PubSub.unbounded<CatalogueStatus>();
    const cachePath = join(options.dataDir, "catalogue.json");
    let catalogue: IndexedCatalogue | null = null;
    let refreshing: {
      readonly key: string;
      readonly token: object;
      readonly fiber: Fiber.Fiber<CatalogueStatus, Failed>;
    } | null = null;
    /** Why the latest refresh of this subscription failed, until one succeeds. */
    let failure: { readonly key: string; readonly error: AppError } | null = null;

    const requireSource = Effect.flatMap(subscriptions.source, (source) =>
      source
        ? Effect.succeed(source)
        : Effect.fail(new Failed({ error: { kind: "no-subscription" } })),
    );

    /** The catalogue for the current subscription from memory or disk. Never hits the network. */
    const cached = (key: string) =>
      Effect.gen(function* () {
        if (catalogue?.key === key) return catalogue;
        const file = yield* Effect.promise(() => readJsonFile(cachePath, CachedCatalogue));
        if (file?.key !== key) return null;
        if (catalogue?.key !== key) catalogue = index(file, file.outdated);
        return catalogue;
      });

    /** The catalogue for the current subscription, fetching it first if nothing is cached. */
    const current = Effect.gen(function* () {
      const source = yield* requireSource;
      const existing = yield* cached(source.key);
      if (existing) return existing;
      yield* refresh;
      if (catalogue?.key !== source.key) return yield* switched;
      return catalogue;
    });

    /**
     * The catalogue as Live TV shows it: channels for adults only while Settings shows titles for
     * adults, and never in search.
     */
    const shown = (found: IndexedCatalogue) =>
      Effect.map(settings.get, (preferences) => ({
        lists: preferences.adultTitles ? found : withoutAdults(found),
        search: withoutAdults(found),
      }));
    const visible = Effect.flatMap(current, shown);

    const fetchAndStore = (source: Source) =>
      Effect.gen(function* () {
        const fetched = yield* complete(source, yield* cached(source.key));
        // Drop the result if the user switched subscriptions while it downloaded.
        if ((yield* subscriptions.source)?.key !== source.key) return yield* switched;
        const file: CatalogueFile = {
          version: 4,
          key: source.key,
          fetchedAt: yield* Clock.currentTimeMillis,
          categories: fetched.categories,
          channels: fetched.channels,
        };
        // Written before it is used: the next start must not find an older catalogue on disk.
        yield* Effect.promise(() => writeJsonFile(cachePath, file));
        catalogue = index(file, false);
        failure = null;
        const status = statusOf(catalogue, null);
        yield* PubSub.publish(updates, status);
        return status;
      }).pipe(
        diagnosed("catalogue"),
        Effect.tapError((failed) =>
          Effect.gen(function* () {
            failure = { key: source.key, error: failed.error };
            yield* PubSub.publish(updates, statusOf(yield* cached(source.key), failed.error));
          }),
        ),
      );

    const refresh: Effect.Effect<CatalogueStatus, Failed> = Effect.gen(function* () {
      const source = yield* requireSource;
      let running = refreshing?.key === source.key ? refreshing : null;
      if (!running) {
        const token = {};
        const fiber = yield* Effect.forkIn(
          fetchAndStore(source).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (refreshing?.token === token) refreshing = null;
              }),
            ),
          ),
          scope,
        );
        running = { key: source.key, token, fiber };
        refreshing = running;
      }
      return yield* Fiber.join(running.fiber);
    });

    /**
     * Fetches the catalogue and checks it against the one in use. An empty list never replaces
     * channels, and a much shorter one only when a second fetch returns the same.
     */
    const complete = (source: Source, previous: IndexedCatalogue | null) =>
      Effect.gen(function* () {
        const fetch = Effect.tryPromise({
          try: (signal) => source.provider.liveCatalogue(signal),
          catch: failedWith,
        });
        const fetched = yield* fetch;
        const before = previous?.channels.length ?? 0;
        const received = fetched.channels.length;
        if (before === 0 || received >= before * SHRINK_CONFIRM_SHARE) return fetched;
        if (received > 0) {
          yield* Effect.sleep(options.confirmDelay ?? SHRINK_CONFIRM_DELAY);
          const again = yield* fetch;
          const difference = Math.abs(again.channels.length - received);
          if (again.channels.length > 0 && difference <= Math.max(10, received * 0.05)) {
            return again;
          }
        }
        return yield* new Failed({
          error: { kind: "incomplete-catalogue", received, previous: before },
        });
      });

    return {
      refresh,

      isStale: (maxAge: Duration.Input) =>
        Effect.gen(function* () {
          const source = yield* subscriptions.source;
          const existing = source ? yield* cached(source.key) : null;
          const now = yield* Clock.currentTimeMillis;
          return (
            !existing || existing.outdated || now - existing.fetchedAt > Duration.toMillis(maxAge)
          );
        }),

      guideChannels: Effect.map(visible, ({ lists }) => lists.guide),

      status: Effect.gen(function* () {
        const source = yield* subscriptions.source;
        if (!source) return statusOf(null, null);
        const found = yield* cached(source.key);
        return statusOf(
          found && (yield* shown(found)).lists,
          failure?.key === source.key ? failure.error : null,
        );
      }),

      categories: Effect.map(visible, ({ lists }) => lists.categories),

      channels: (filter: {
        readonly categoryId?: string;
        readonly query?: string;
        readonly ids?: readonly string[];
      }) =>
        Effect.map(visible, ({ lists: { channels, byCategory, byId }, search: searched }) => {
          if (filter.ids) return [...new Set(filter.ids.flatMap((id) => byId.get(id) ?? []))];
          const query = normalize(filter.query ?? "");
          if (query) return search(searched.channels, searched.searchNames, query);
          return filter.categoryId === undefined
            ? channels
            : (byCategory.get(filter.categoryId) ?? []);
        }),

      channel: (channelId: string) =>
        Effect.flatMap(visible, ({ lists: { byId } }) => {
          const channel = byId.get(channelId);
          return channel
            ? Effect.succeed(channel)
            : Effect.fail(new Failed({ error: { kind: "channel-not-found", channelId } }));
        }),

      lookup: Effect.gen(function* () {
        const source = yield* subscriptions.source;
        const found = source ? yield* cached(source.key) : null;
        return (channelId: string) => found?.byId.get(channelId);
      }),

      clear: Effect.gen(function* () {
        catalogue = null;
        failure = null;
        yield* Effect.promise(() => removeFile(cachePath));
      }),

      changes: Stream.fromPubSub(updates),
    };
  });
}

const switched = Effect.fail(
  new Failed({
    error: { kind: "unexpected", detail: "The subscription changed while loading channels." },
  }),
);

function statusOf(catalogue: IndexedCatalogue | null, failure: AppError | null): CatalogueStatus {
  return {
    channelCount: catalogue?.channels.length ?? 0,
    fetchedAt: catalogue?.fetchedAt ?? null,
    failure,
  };
}

function index(file: CatalogueFile, outdated: boolean): IndexedCatalogue {
  const { categories, streams } = normalizeCatalogue(file);
  const logical = liveChannels(streams);
  const { guideIds } = logical;
  // A channel is for adults when one of its streams is.
  const isAdult = adultIn(file.categories);
  const adultStreams = new Set(file.channels.filter(isAdult).map((channel) => channel.id));
  const channels = logical.channels.map((channel): LiveChannel =>
    channel.variants.some((variant) => adultStreams.has(variant.id))
      ? { ...channel, adult: true }
      : channel,
  );
  const byId = new Map<string, LiveChannel>();
  const byGuideId = new Map<string, LiveChannel[]>();
  for (const channel of channels) {
    byId.set(channel.id, channel);
    for (const variant of channel.variants) byId.set(variant.id, channel);
    const guideId = guideIds.get(channel.id);
    if (!guideId) continue;
    const list = byGuideId.get(guideId);
    if (list) list.push(channel);
    else byGuideId.set(guideId, [channel]);
  }
  // A channel shows in each of its streams' categories, once, where its first stream there is.
  const byCategory = new Map<string, LiveChannel[]>();
  const placed = new Set<string>();
  for (const stream of streams) {
    const channel = byId.get(stream.id);
    if (!channel) continue;
    for (const categoryId of stream.categoryIds) {
      const key = `${categoryId}\n${channel.id}`;
      if (placed.has(key)) continue;
      placed.add(key);
      const list = byCategory.get(categoryId);
      if (list) list.push(channel);
      else byCategory.set(categoryId, [channel]);
    }
  }
  return {
    key: file.key,
    fetchedAt: file.fetchedAt,
    outdated,
    categories: categories
      .map((category) => ({ ...category, channelCount: byCategory.get(category.id)?.length ?? 0 }))
      .filter((category) => category.channelCount > 0),
    channels,
    byId,
    byCategory,
    searchNames: channels.map((channel) =>
      normalize(channel.variants.map((variant) => variant.name).join(" ")),
    ),
    guide: {
      guideIdOf: (channelId) => guideIds.get(byId.get(channelId)?.id ?? channelId) ?? null,
      channelsOf: (guideId) => byGuideId.get(guideId) ?? [],
    },
  };
}

/** The catalogue without channels for adults, kept per catalogue once worked out. */
const adultless = new WeakMap<IndexedCatalogue, IndexedCatalogue>();

/** The catalogue without channels for adults, nor the categories left empty without them. */
function withoutAdults(found: IndexedCatalogue): IndexedCatalogue {
  if (!found.channels.some((channel) => channel.adult)) return found;
  const known = adultless.get(found);
  if (known) return known;
  const kept = (channel: LiveChannel | undefined) => channel !== undefined && !channel.adult;
  const keep = [...found.channels.keys()].filter((at) => kept(found.channels[at]));
  const byCategory = new Map(
    [...found.byCategory].map(([id, channels]) => [id, channels.filter(kept)] as const),
  );
  const made: IndexedCatalogue = {
    ...found,
    categories: found.categories
      .map((category) => ({ ...category, channelCount: byCategory.get(category.id)?.length ?? 0 }))
      .filter((category) => category.channelCount > 0),
    channels: found.channels.filter(kept),
    byId: new Map([...found.byId].filter(([, channel]) => kept(channel))),
    byCategory,
    searchNames: keep.map((at) => found.searchNames[at] ?? ""),
    guide: {
      guideIdOf: (channelId) =>
        kept(found.byId.get(channelId)) ? found.guide.guideIdOf(channelId) : null,
      channelsOf: (guideId) => found.guide.channelsOf(guideId).filter(kept),
    },
  };
  adultless.set(found, made);
  return made;
}

/**
 * Every query word must appear in the channel name. Names that start with the query rank first,
 * then names with a word starting with it, then the rest. Ties keep provider order.
 */
function search(
  channels: readonly LiveChannel[],
  names: readonly string[],
  query: string,
): LiveChannel[] {
  const words = query.split(" ");
  const ranked: { channel: LiveChannel; rank: number; order: number }[] = [];
  for (const [order, channel] of channels.entries()) {
    const name = names[order] ?? "";
    if (!words.every((word) => name.includes(word))) continue;
    const rank = name.startsWith(query) ? 0 : ` ${name}`.includes(` ${query}`) ? 1 : 2;
    ranked.push({ channel, rank, order });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return ranked.slice(0, SEARCH_LIMIT).map((entry) => entry.channel);
}
