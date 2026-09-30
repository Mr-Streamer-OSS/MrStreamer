// The programme guide: the provider's XMLTV, kept on disk as it arrived and indexed in memory by
// guide channel. Browsing and playback never wait for it; until a guide is loaded, channels simply
// have no listings. The document is read as it streams in, from the network or from disk, so no
// step holds the main process for long, and programmes that already ended are left out.
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { Listing, Programme, ProgrammeMatch } from "@mrstreamer/contracts/guide";
import { normalize } from "@mrstreamer/core/text";
import { xmltvReader, type XmltvProgramme } from "@mrstreamer/core/guide/xmltv";
import { readJsonFile, removeFile, writeJsonFile } from "../platform/json-file.ts";
import type { CatalogueSource, GuideChannels } from "./library.ts";

/** A guide older than this is downloaded again. Providers cover about a day ahead. */
const GUIDE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** How many programmes a search returns. */
const SEARCH_LIMIT = 50;
/** Indexing pauses for other work after this many guide channels. */
const YIELD_EVERY_CHANNELS = 50;

/** Which subscription the guide on disk belongs to, and when it was downloaded. */
const GuideMeta = type({ key: "string", fetchedAt: "number" });

export interface GuideDeps {
  readonly dataDir: string;
  readonly source: () => Promise<CatalogueSource | null>;
  /** The current catalogue's channels by guide id. */
  readonly channels: () => Promise<GuideChannels>;
  /** Called after a new guide is loaded. */
  readonly onUpdated: () => void;
  /** The clock; tests move it. */
  readonly now?: () => number;
}

interface Titled {
  readonly guideId: string;
  /** The title as search compares it. */
  readonly folded: string;
  readonly programme: Programme;
}

interface Index {
  readonly key: string;
  readonly fetchedAt: number;
  /** Programmes per guide channel, in time order and without overlaps. */
  readonly byChannel: ReadonlyMap<string, readonly Programme[]>;
  readonly titles: readonly Titled[];
}

export type Guide = ReturnType<typeof createGuide>;

export function createGuide(deps: GuideDeps) {
  const now = deps.now ?? Date.now;
  const documentPath = join(deps.dataDir, "guide.xml");
  const metaPath = join(deps.dataDir, "guide.json");
  let index: Index | null = null;
  let loading: { readonly key: string; readonly run: Promise<Index | null> } | null = null;
  let refreshing: { readonly key: string; readonly run: Promise<void> } | null = null;

  /** The guide of the current subscription: from memory, or read from disk once. Null without one. */
  async function current(): Promise<Index | null> {
    const source = await deps.source();
    if (!source) return null;
    if (index?.key === source.key) return index;
    if (loading?.key !== source.key) {
      const run = loadFromDisk(source.key).finally(() => {
        if (loading?.run === run) loading = null;
      });
      loading = { key: source.key, run };
    }
    const loaded = await loading.run;
    // A download may have finished while the disk copy was read.
    if (index?.key === source.key) return index;
    if (loaded) index = loaded;
    return loaded;
  }

  async function loadFromDisk(key: string): Promise<Index | null> {
    const meta = await readJsonFile(metaPath, GuideMeta);
    if (meta?.key !== key) return null;
    try {
      const file = createReadStream(documentPath, { highWaterMark: 64 * 1024 });
      return await build(key, meta.fetchedAt, file);
    } catch (cause) {
      console.warn("[guide] ignoring the guide on disk", cause);
      return null;
    }
  }

  /**
   * Downloads the guide, saving it next to the old one until it is complete. A failed download
   * keeps the guide in use. Concurrent calls for one subscription share a download.
   */
  async function refresh(): Promise<void> {
    const source = await deps.source();
    if (!source) throw new AppFailure({ kind: "no-subscription" });
    if (refreshing?.key === source.key) return refreshing.run;
    const run = download(source).finally(() => {
      if (refreshing?.run === run) refreshing = null;
    });
    refreshing = { key: source.key, run };
    return run;
  }

  async function download(source: CatalogueSource): Promise<void> {
    const fetchedAt = now();
    const body = await source.provider.liveGuide();
    await mkdir(deps.dataDir, { recursive: true });
    const partial = `${documentPath}.${randomUUID()}.tmp`;
    const file = await open(partial, "w");
    let fresh: Index;
    try {
      fresh = await build(source.key, fetchedAt, saving(body, file));
    } catch (cause) {
      await file.close().catch(() => {});
      await rm(partial, { force: true });
      throw cause;
    }
    await file.close();
    // Drop it if the subscription changed meanwhile.
    if ((await deps.source())?.key !== source.key) {
      await rm(partial, { force: true });
      return;
    }
    await rename(partial, documentPath);
    await writeJsonFile(metaPath, { key: source.key, fetchedAt });
    index = fresh;
    deps.onUpdated();
  }

  /** Indexes a document, dropping programmes that ended before now. */
  async function build(
    key: string,
    fetchedAt: number,
    document: AsyncIterable<Uint8Array>,
  ): Promise<Index> {
    const since = now();
    const reader = xmltvReader();
    const raw = new Map<string, XmltvProgramme[]>();
    // Titles folded for search as they arrive, once per distinct title, to keep the last step short.
    const folded = new Map<string, string>();
    let read = 0;
    for await (const chunk of document) {
      for (const entry of reader.push(chunk)) {
        read++;
        if (entry.stop !== null && entry.stop <= since) continue;
        const list = raw.get(entry.channel);
        if (list) list.push(entry);
        else raw.set(entry.channel, [entry]);
        if (!folded.has(entry.title)) folded.set(entry.title, normalize(entry.title));
      }
    }
    if (read === 0) {
      throw new AppFailure({ kind: "unexpected", detail: "The guide lists no programmes." });
    }
    const byChannel = new Map<string, readonly Programme[]>();
    const titles: Titled[] = [];
    let done = 0;
    for (const [guideId, entries] of raw) {
      // Lets IPC and playback in between, every so many channels.
      if (++done % YIELD_EVERY_CHANNELS === 0)
        await new Promise((resolve) => setImmediate(resolve));
      const programmes = timeline(entries).filter((programme) => programme.stop > since);
      if (programmes.length === 0) continue;
      byChannel.set(guideId, programmes);
      for (const programme of programmes) {
        titles.push({ guideId, folded: folded.get(programme.title) ?? "", programme });
      }
    }
    return { key, fetchedAt, byChannel, titles };
  }

  return {
    refresh,

    /** Downloads the guide when there is none or it is older than `GUIDE_MAX_AGE_MS`. */
    async refreshIfStale(): Promise<void> {
      const loaded = await current();
      if (loaded && now() - loaded.fetchedAt < GUIDE_MAX_AGE_MS) return;
      await refresh();
    },

    /** What each channel shows now and next. Channels without guide data are left out. */
    async listings(channelIds: readonly string[]): Promise<Record<string, Listing>> {
      const loaded = await current();
      if (!loaded) return {};
      const channels = await deps.channels();
      const at = now();
      const result: Record<string, Listing> = {};
      for (const channelId of channelIds) {
        const programmes = programmesOf(loaded, channels, channelId);
        const from = firstUnfinished(programmes, at);
        const first = programmes[from];
        if (!first) continue;
        result[channelId] =
          first.start <= at
            ? { now: first, next: programmes[from + 1] ?? null }
            : { now: null, next: first };
      }
      return result;
    },

    /** The channel's programme on now and everything after it that the guide knows. */
    async schedule(channelId: string): Promise<readonly Programme[]> {
      const loaded = await current();
      if (!loaded) return [];
      const programmes = programmesOf(loaded, await deps.channels(), channelId);
      return programmes.slice(firstUnfinished(programmes, now()));
    },

    /**
     * Programmes on now or later whose title has every word of `query`, on the first channel in
     * the catalogue that shows them. On now comes first, then by start time.
     */
    async search(query: string): Promise<readonly ProgrammeMatch[]> {
      const words = normalize(query).split(" ").filter(Boolean);
      const loaded = words.length > 0 ? await current() : null;
      if (!loaded) return [];
      const channels = await deps.channels();
      const at = now();
      const matches: ProgrammeMatch[] = [];
      for (const { guideId, folded, programme } of loaded.titles) {
        if (programme.stop <= at || !words.every((word) => folded.includes(word))) continue;
        const channel = channels.channelsOf(guideId)[0];
        if (channel) matches.push({ channel, programme });
      }
      const onNow = (match: ProgrammeMatch) => (match.programme.start <= at ? 0 : 1);
      matches.sort((a, b) => onNow(a) - onNow(b) || a.programme.start - b.programme.start);
      return matches.slice(0, SEARCH_LIMIT);
    },

    /** Forgets the guide, for when the subscription changes or is removed. */
    async clear(): Promise<void> {
      index = null;
      loading = null;
      await Promise.all([removeFile(documentPath), removeFile(metaPath)]);
    },
  };
}

function programmesOf(
  loaded: Index,
  channels: GuideChannels,
  channelId: string,
): readonly Programme[] {
  const guideId = channels.guideIdOf(channelId);
  return (guideId && loaded.byChannel.get(guideId)) || [];
}

/** The position of the first programme that hasn't ended at `at`. */
function firstUnfinished(programmes: readonly Programme[], at: number): number {
  let low = 0;
  let high = programmes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((programmes[middle]?.stop ?? 0) <= at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * One channel's programmes in time order, without overlaps: a programme without an end runs until
 * the next one starts, a programme that starts before the previous one ends cuts it short, and
 * duplicates of a start time count once.
 */
function timeline(entries: readonly XmltvProgramme[]): Programme[] {
  const sorted = entries.toSorted((a, b) => a.start - b.start);
  const result: Programme[] = [];
  for (const [position, entry] of sorted.entries()) {
    const previous = result.at(-1);
    if (previous?.start === entry.start) continue;
    if (previous && previous.stop > entry.start) {
      result[result.length - 1] = { ...previous, stop: entry.start };
    }
    const stop = entry.stop ?? sorted[position + 1]?.start;
    if (stop === undefined || stop <= entry.start) continue;
    result.push({
      start: entry.start,
      stop,
      title: entry.title,
      description: entry.description,
    });
  }
  return result;
}

/** Passes the download on while writing it, as it came, to `file`. */
async function* saving(
  body: ReadableStream<Uint8Array>,
  file: { write(data: Uint8Array): Promise<unknown> },
): AsyncGenerator<Uint8Array> {
  for await (const bytes of body) {
    await file.write(bytes);
    yield bytes;
  }
}
