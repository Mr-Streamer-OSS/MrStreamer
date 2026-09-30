// The live catalogue: fetched from the provider, cached on disk, queried by the UI over IPC.
import { join } from "node:path";
import { type } from "arktype";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { CatalogueStatus, Category, LiveChannel } from "@mrstreamer/contracts/library";
import { normalize } from "@mrstreamer/core/text";
import { trustedGuideIds } from "@mrstreamer/core/catalogue/guide-ids";
import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import { readJsonFile, removeFile, writeJsonFile } from "../platform/json-file.ts";
import type { LiveCatalogue, LiveProvider } from "@mrstreamer/core/provider";

/** How many results a search returns. Enough to scroll, small enough to send per keystroke. */
const SEARCH_LIMIT = 200;
/**
 * A refresh that returns fewer than this share of the channels before counts as possibly
 * incomplete. It replaces the catalogue only when a second fetch confirms it.
 */
const SHRINK_CONFIRM_SHARE = 0.5;
const SHRINK_CONFIRM_DELAY_MS = 3000;

// The cache stores the catalogue as the provider sent it, and display names are worked out on
// load, so improved naming rules apply without fetching again. The newest stable release reads it
// too (see docs/maintainers/architecture.md), so fields are added without a new version: a file
// written before guide ids still loads, and counts as outdated.
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
  }).array(),
}).pipe((file) => ({
  ...file,
  channels: file.channels.map((channel) => ({ ...channel, guideId: channel.guideId ?? null })),
  outdated: file.channels.some((channel) => channel.guideId === undefined),
}));

/** What the disk cache holds. */
interface CatalogueFile extends LiveCatalogue {
  readonly version: 4;
  readonly key: string;
  readonly fetchedAt: number;
}

/** The connected subscription as the library needs it. `key` changes when the login does. */
export interface CatalogueSource {
  readonly key: string;
  readonly provider: LiveProvider;
}

export interface LibraryDeps {
  readonly dataDir: string;
  readonly source: () => Promise<CatalogueSource | null>;
  /** Called after every refresh, successful or not. */
  readonly onUpdated: (status: CatalogueStatus) => void;
  /** Waits before a confirming fetch. Tests make it instant. */
  readonly confirmDelayMs?: number;
}

interface IndexedCatalogue {
  readonly key: string;
  readonly fetchedAt: number;
  /** Written by a version that didn't keep guide ids. */
  readonly outdated: boolean;
  readonly categories: readonly Category[];
  readonly channels: readonly LiveChannel[];
  readonly byId: ReadonlyMap<string, LiveChannel>;
  /** Channels per category id, in provider order. */
  readonly byCategory: ReadonlyMap<string, readonly LiveChannel[]>;
  /** Normalised names, index-aligned with `channels`. */
  readonly searchNames: readonly string[];
  readonly guide: GuideChannels;
}

/** How catalogue channels map to the provider's programme guide. */
export interface GuideChannels {
  guideIdOf(channelId: string): string | null;
  /** The channels showing a guide channel, in catalogue order. */
  channelsOf(guideId: string): readonly LiveChannel[];
}

export type Library = ReturnType<typeof createLibrary>;

export function createLibrary(deps: LibraryDeps) {
  const cachePath = join(deps.dataDir, "catalogue.json");
  let catalogue: IndexedCatalogue | null = null;
  let refreshing: { readonly key: string; readonly run: Promise<CatalogueStatus> } | null = null;
  /** Why the latest refresh of this subscription failed, until one succeeds. */
  let failure: { readonly key: string; readonly error: AppError } | null = null;

  async function requireSource(): Promise<CatalogueSource> {
    const source = await deps.source();
    if (!source) throw new AppFailure({ kind: "no-subscription" });
    return source;
  }

  /** The catalogue for the current subscription from memory or disk. Never hits the network. */
  async function cached(key: string): Promise<IndexedCatalogue | null> {
    if (catalogue?.key === key) return catalogue;
    const file = await readJsonFile(cachePath, CachedCatalogue);
    if (file?.key !== key) return null;
    if (catalogue?.key !== key) catalogue = index(file, file.outdated);
    return catalogue;
  }

  /** The catalogue for the current subscription, fetching it first if nothing is cached. */
  async function current(): Promise<IndexedCatalogue> {
    const source = await requireSource();
    const existing = await cached(source.key);
    if (existing) return existing;
    await refresh();
    if (catalogue?.key !== source.key) {
      throw new AppFailure({
        kind: "unexpected",
        detail: "The subscription changed while loading channels.",
      });
    }
    return catalogue;
  }

  /** Fetches the catalogue from the provider. Concurrent calls for one subscription share a request. */
  async function refresh(): Promise<CatalogueStatus> {
    const source = await requireSource();
    if (refreshing?.key === source.key) return refreshing.run;

    const run = (async () => {
      try {
        const fetched = await complete(source, await cached(source.key));
        // Drop the result if the user switched subscriptions while it downloaded.
        if ((await deps.source())?.key !== source.key) {
          throw new AppFailure({
            kind: "unexpected",
            detail: "The subscription changed while loading channels.",
          });
        }
        const file: CatalogueFile = {
          version: 4,
          key: source.key,
          fetchedAt: Date.now(),
          categories: fetched.categories,
          channels: fetched.channels,
        };
        // Written before it is used: the next start must not find an older catalogue on disk.
        await writeJsonFile(cachePath, file);
        catalogue = index(file, false);
        failure = null;
      } catch (cause) {
        if (cause instanceof AppFailure) failure = { key: source.key, error: cause.error };
        deps.onUpdated(statusOf(await cached(source.key), failure?.error ?? null));
        throw cause;
      }
      const status = statusOf(catalogue, null);
      deps.onUpdated(status);
      return status;
    })().finally(() => {
      if (refreshing?.run === run) refreshing = null;
    });
    refreshing = { key: source.key, run };
    return run;
  }

  /**
   * Fetches the catalogue and checks it against the one in use. An empty list never replaces
   * channels, and a much shorter one only when a second fetch returns the same.
   */
  async function complete(
    source: CatalogueSource,
    previous: IndexedCatalogue | null,
  ): Promise<LiveCatalogue> {
    const fetched = await source.provider.liveCatalogue();
    const before = previous?.channels.length ?? 0;
    const received = fetched.channels.length;
    if (before === 0 || received >= before * SHRINK_CONFIRM_SHARE) return fetched;
    if (received > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, deps.confirmDelayMs ?? SHRINK_CONFIRM_DELAY_MS),
      );
      const again = await source.provider.liveCatalogue();
      const difference = Math.abs(again.channels.length - received);
      if (again.channels.length > 0 && difference <= Math.max(10, received * 0.05)) return again;
    }
    throw new AppFailure({ kind: "incomplete-catalogue", received, previous: before });
  }

  return {
    refresh,

    /** Whether the catalogue should be fetched again: missing, older than `maxAgeMs`, or outdated. */
    async isStale(maxAgeMs: number): Promise<boolean> {
      const source = await deps.source();
      const existing = source ? await cached(source.key) : null;
      return !existing || existing.outdated || Date.now() - existing.fetchedAt > maxAgeMs;
    },

    /** The channels of the current catalogue by guide id, for the programme guide. */
    async guideChannels(): Promise<GuideChannels> {
      return (await current()).guide;
    },

    async status(): Promise<CatalogueStatus> {
      const source = await deps.source();
      if (!source) return statusOf(null, null);
      return statusOf(await cached(source.key), failure?.key === source.key ? failure.error : null);
    },

    async categories(): Promise<readonly Category[]> {
      return (await current()).categories;
    },

    /** Channels in one category, all channels, or search matches across the catalogue when `query` is set. */
    async channels(filter: {
      categoryId?: string;
      query?: string;
      ids?: readonly string[];
    }): Promise<readonly LiveChannel[]> {
      const { channels, byCategory, byId, searchNames } = await current();
      if (filter.ids) return filter.ids.flatMap((id) => byId.get(id) ?? []);
      const query = normalize(filter.query ?? "");
      if (query) return search(channels, searchNames, query);
      return filter.categoryId === undefined ? channels : (byCategory.get(filter.categoryId) ?? []);
    },

    async channel(channelId: string): Promise<LiveChannel> {
      const channel = (await current()).byId.get(channelId);
      if (!channel) throw new AppFailure({ kind: "channel-not-found", channelId });
      return channel;
    },

    /** Forgets the cached catalogue, for when the subscription is removed. */
    async clear(): Promise<void> {
      catalogue = null;
      failure = null;
      await removeFile(cachePath);
    },
  };
}

function statusOf(catalogue: IndexedCatalogue | null, failure: AppError | null): CatalogueStatus {
  return {
    channelCount: catalogue?.channels.length ?? 0,
    fetchedAt: catalogue?.fetchedAt ?? null,
    failure,
  };
}

function index(file: CatalogueFile, outdated: boolean): IndexedCatalogue {
  const { categories, channels } = normalizeCatalogue(file);
  const byCategory = new Map<string, LiveChannel[]>();
  const byId = new Map<string, LiveChannel>();
  for (const channel of channels) {
    byId.set(channel.id, channel);
    for (const categoryId of channel.categoryIds) {
      const list = byCategory.get(categoryId);
      if (list) list.push(channel);
      else byCategory.set(categoryId, [channel]);
    }
  }
  const guideIds = trustedGuideIds(
    file.channels.flatMap(({ id, guideId }) => {
      const channel = byId.get(id);
      return channel && guideId ? [{ channel, guideId }] : [];
    }),
  );
  const byGuideId = new Map<string, LiveChannel[]>();
  for (const [id, guideId] of guideIds) {
    const channel = byId.get(id);
    if (!channel) continue;
    const list = byGuideId.get(guideId);
    if (list) list.push(channel);
    else byGuideId.set(guideId, [channel]);
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
    searchNames: channels.map((channel) => normalize(channel.name)),
    guide: {
      guideIdOf: (channelId) => guideIds.get(channelId) ?? null,
      channelsOf: (guideId) => byGuideId.get(guideId) ?? [],
    },
  };
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
