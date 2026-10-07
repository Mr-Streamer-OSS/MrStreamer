// The programme guide in memory: programmes per guide channel, and the lookups the UI asks for.
// Built from an XMLTV document as it streams in, dropping programmes that already ended.
//
// A catalogue channel shows the programmes of the guide channel its own guide id names, when the
// guide has that id exactly; or of the one the viewer mapped it to by hand, which then counts
// alone. Nothing is ever matched by name. `mappedChannels` lays the viewer's mappings over a
// catalogue's guide ids, both ways, so every lookup here reads one and the same answer.
import { AppFailure } from "@mrstreamer/contracts/errors";
import type {
  GuideChannel,
  GuideChannelPage,
  GuideFailure,
  Listing,
  ListingMatch,
  MapChannel,
  MapFilter,
  Programme,
  ProgrammeMatch,
} from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { normalize, searchWords } from "../text.ts";
import { GUIDE_LIMITS, type GuideLimits } from "./limits.ts";
import { xmltvReader, type XmltvProgramme } from "./xmltv.ts";

/** How many programmes a search returns. */
export const SEARCH_LIMIT = 50;
/**
 * Indexing pauses for other work once it has put this many programmes in order: fifty channels
 * of a guide that lists a day and a half ahead, and fewer of one that lists a week.
 */
const YIELD_EVERY_PROGRAMMES = 2_000;

/** How catalogue channels map to the guide. */
export interface GuideChannels {
  /**
   * The channel's guide ids: none, one, or each spelling its streams give of one, "vtm.be" and
   * "vtm BE". The channel shows the programmes of the first the guide has any for.
   */
  guideIdsOf(channelId: string): readonly string[];
  /** The channels a guide id is one of, in catalogue order. */
  channelsOf(guideId: string): readonly LiveChannel[];
}

/** A subscription's channels as the lists show them, with their guide ids. */
export interface CatalogueChannels extends GuideChannels {
  /** Every channel the lists show, in their order. */
  readonly all: readonly LiveChannel[];
  /**
   * What a search compares each of `all` by, in the same order: its names, folded as
   * `normalize` folds text. Folded once with the catalogue, since folding thousands of names
   * takes longer than a search may hold the process.
   */
  readonly searchNames: readonly string[];
  /** The channel by its id or any of its streams', when the lists show it. */
  channel(channelId: string): LiveChannel | undefined;
  /** Whether the catalogue lists the channel at all, shown or not. */
  listed(channelId: string): boolean;
}

/** A channel the viewer mapped by hand, as it is kept. */
export interface GuideMapping {
  /** The guide channel's id, exactly as the guide writes it. */
  readonly guideId: string;
  /** What the channel was called then, to name it once the provider no longer lists it. */
  readonly name: string;
}

/** A catalogue's channels with the viewer's mappings laid over their guide ids. */
export interface MappedChannels extends CatalogueChannels {
  /** The guide channel the viewer mapped each channel to, by the channel's id. */
  readonly mapped: ReadonlyMap<string, string>;
  /** Mappings of channels the catalogue no longer lists, by the id each was mapped under. */
  readonly unlisted: ReadonlyMap<string, GuideMapping>;
}

/**
 * `channels` with `mappings`, by channel id, over its guide ids. A mapped channel has the guide
 * id it was mapped to and no other, also when the guide doesn't list that one: it then shows no
 * programmes, rather than another channel's. A guide id's channels are those that name it
 * themselves and aren't mapped elsewhere, with those mapped to it, in catalogue order.
 *
 * A mapping is kept under the channel's id as it was then and finds the channel by any of its
 * streams' ids, as the catalogue does, so it holds when the provider lists the streams anew.
 */
export function mappedChannels(
  channels: CatalogueChannels,
  mappings: Readonly<Record<string, GuideMapping>>,
): MappedChannels {
  const entries = Object.entries(mappings);
  if (entries.length === 0) return { ...channels, mapped: new Map(), unlisted: new Map() };
  const mapped = new Map<string, string>();
  /** The channels mapped to each guide id. */
  const reverse = new Map<string, LiveChannel[]>();
  const unlisted = new Map<string, GuideMapping>();
  for (const [key, mapping] of entries) {
    const channel = channels.channel(key);
    if (!channel) {
      // One the lists only hide for now is neither shown nor gone.
      if (!channels.listed(key)) unlisted.set(key, mapping);
      continue;
    }
    mapped.set(channel.id, mapping.guideId);
    const list = reverse.get(mapping.guideId);
    if (list) list.push(channel);
    else reverse.set(mapping.guideId, [channel]);
  }
  let positions: Map<string, number> | null = null;
  const position = (channel: LiveChannel) => {
    positions ??= new Map(channels.all.map((each, at) => [each.id, at]));
    return positions.get(channel.id) ?? Number.POSITIVE_INFINITY;
  };
  return {
    ...channels,
    mapped,
    unlisted,
    guideIdsOf: (channelId) => {
      const guideId = mapped.get(channels.channel(channelId)?.id ?? channelId);
      return guideId === undefined ? channels.guideIdsOf(channelId) : [guideId];
    },
    channelsOf: (guideId) => {
      const own = channels.channelsOf(guideId).filter((channel) => !mapped.has(channel.id));
      const others = reverse.get(guideId);
      if (!others) return own;
      return [...own, ...others].sort((a, b) => position(a) - position(b));
    },
  };
}

interface Titled {
  readonly guideId: string;
  /** The title as search compares it. */
  readonly folded: string;
  readonly programme: Programme;
}

export interface ProgrammeIndex {
  /** Programmes per guide channel, in time order and without overlaps. */
  readonly byChannel: ReadonlyMap<string, readonly Programme[]>;
  /** Every programme with its title as search compares it, each guide channel's in time order. */
  readonly titles: readonly Titled[];
  /**
   * Every channel the guide lists, by its id: those it names in a `<channel>`, and those it only
   * lists programmes for, which go by their id. `folded` is what search compares and orders it
   * by: its name folded, then its id in lower case, on a line of its own so that "Canal Nord"
   * comes before "Canal Nord +1".
   */
  readonly channels: ReadonlyMap<string, { readonly name: string; readonly folded: string }>;
  /** When its last programme ends, or null without one that hasn't ended. */
  readonly until: number | null;
}

/**
 * Indexes an XMLTV document, leaving out programmes that ended before `since`. Reads it chunk by
 * chunk and pauses between channels at the end, so no step holds the process for long. Fails when
 * the document lists no programmes at all, or is past one of `limits`.
 *
 * `strict` is for a document as it downloads from an address the viewer gave: it also fails
 * unless the document is one whole `<tv>` from its opening tag to its closing one, and unless a
 * programme of it is still to come. A document read from disk was whole when it was saved, and
 * an own guide is taken as its provider sends it, as it always was.
 */
export async function indexProgrammes(
  document: AsyncIterable<Uint8Array>,
  since: number,
  { strict = false, limits = GUIDE_LIMITS }: { strict?: boolean; limits?: GuideLimits } = {},
): Promise<ProgrammeIndex> {
  const raw = new Map<string, XmltvProgramme[]>();
  const channels = new Map<string, { readonly name: string; readonly folded: string }>();
  // Titles folded for search as they arrive, once per distinct title, to keep the last step short.
  const folded = new Map<string, string>();
  let read = 0;
  let kept = 0;
  /**
   * Counts a guide channel the first time the document names it, and folds its name for search
   * then, as it arrives: thousands of names folded at once would hold the process.
   */
  const listed = (id: string, name: string | null) => {
    const known = channels.get(id);
    if (!known && channels.size === limits.channels) throw unusable("channels");
    // A name given later, or again, stands; programmes alone name a channel by its id.
    if (known && name === null) return;
    const shown = name ?? id;
    channels.set(id, { name: shown, folded: `${normalize(shown)}\n${id.toLowerCase()}` });
  };
  const reader = xmltvReader(
    {
      channel: ({ id, name }) => listed(id, name),
      programme(entry) {
        read++;
        if (entry.stop !== null && entry.stop <= since) return;
        if (++kept > limits.programmes) throw unusable("programmes");
        if (!channels.has(entry.channel)) listed(entry.channel, null);
        const list = raw.get(entry.channel);
        if (list) list.push(entry);
        else raw.set(entry.channel, [entry]);
        if (!folded.has(entry.title)) folded.set(entry.title, normalize(entry.title));
      },
    },
    limits.elementBytes,
  );
  for await (const chunk of document) reader.push(chunk);
  const ending = reader.end();
  if (strict && ending !== "whole") throw failure({ kind: ending });
  if (read === 0) throw failure({ kind: "empty" });
  const byChannel = new Map<string, readonly Programme[]>();
  const titles: Titled[] = [];
  let until: number | null = null;
  let ordered = 0;
  for (const [guideId, entries] of raw) {
    // Lets other work in between, every so many programmes.
    if ((ordered += entries.length) >= YIELD_EVERY_PROGRAMMES) {
      ordered = 0;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const programmes = timeline(entries).filter((programme) => programme.stop > since);
    const last = programmes.at(-1);
    if (!last) continue;
    byChannel.set(guideId, programmes);
    until = Math.max(until ?? 0, last.stop);
    for (const programme of programmes) {
      titles.push({ guideId, folded: folded.get(programme.title) ?? "", programme });
    }
  }
  if (strict && byChannel.size === 0) throw failure({ kind: "ended" });
  return { byChannel, titles, channels, until };
}

function failure(failure: GuideFailure): AppFailure {
  return new AppFailure({ kind: "guide", failure });
}

function unusable(limit: "channels" | "programmes"): AppFailure {
  return failure({ kind: "too-large", limit });
}

/** What each channel shows now and next at `at`. Channels without guide data are left out. */
export function listingsAt(
  index: ProgrammeIndex,
  channels: GuideChannels,
  channelIds: readonly string[],
  at: number,
): Record<string, Listing> {
  const result: Record<string, Listing> = {};
  for (const channelId of channelIds) {
    const programmes = programmesOf(index, channels, channelId);
    const from = firstUnfinished(programmes, at);
    const first = programmes[from];
    if (!first) continue;
    result[channelId] =
      first.start <= at
        ? { now: first, next: programmes[from + 1] ?? null }
        : { now: null, next: first };
  }
  return result;
}

/** How many of the catalogue's channels the guide has programmes for. */
export function channelsCovered(index: ProgrammeIndex, channels: GuideChannels): number {
  let count = 0;
  for (const guideId of index.byChannel.keys()) {
    for (const channel of channels.channelsOf(guideId)) {
      if (shownGuideId(index, channels, channel.id) === guideId) count++;
    }
  }
  return count;
}

/** The channel's programme on now and everything after it that the guide knows. */
export function scheduleAt(
  index: ProgrammeIndex,
  channels: GuideChannels,
  channelId: string,
  at: number,
): readonly Programme[] {
  const programmes = programmesOf(index, channels, channelId);
  return programmes.slice(firstUnfinished(programmes, at));
}

/**
 * Programmes on now or later whose title has every word of `query`, on the first channel in the
 * catalogue that shows them. On now comes first, then by start time.
 */
export function searchAt(
  index: ProgrammeIndex,
  channels: GuideChannels,
  query: string,
  at: number,
): readonly ProgrammeMatch[] {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const matches: ProgrammeMatch[] = [];
  for (const { guideId, folded, programme } of index.titles) {
    if (programme.stop <= at || !words.every((word) => folded.includes(word))) continue;
    // Channels for adults show only in Live TV's lists, never in search.
    const channel = channels
      .channelsOf(guideId)
      .find((each) => !each.adult && shownGuideId(index, channels, each.id) === guideId);
    if (channel) matches.push({ channel, programme });
  }
  const onNow = (match: ProgrammeMatch) => (match.programme.start <= at ? 0 : 1);
  matches.sort((a, b) => onNow(a) - onNow(b) || a.programme.start - b.programme.start);
  return matches.slice(0, SEARCH_LIMIT);
}

/**
 * What a search for `query` finds in the programmes of `channelIds`, by channel id: whether the
 * one on now has every word in its title, and the first later one starting before `until` that
 * does. Channels without a match are left out. Every channel given is searched, on the guide id
 * it shows, so channels that share one are each found and nothing is cut off; those for adults
 * count like any other, as a list holds them only while the catalogue shows them.
 */
export function searchChannelsAt(
  index: ProgrammeIndex,
  channels: GuideChannels,
  channelIds: readonly string[],
  query: string,
  at: number,
  until: number,
): Record<string, ListingMatch> {
  const words = searchWords(query);
  if (words.length === 0) return {};
  const showing = new Map<string, string[]>();
  for (const channelId of channelIds) {
    const guideId = shownGuideId(index, channels, channelId);
    if (guideId === undefined) continue;
    const ids = showing.get(guideId);
    if (ids) ids.push(channelId);
    else showing.set(guideId, [channelId]);
  }
  const found = new Map<string, ListingMatch>();
  for (const { guideId, folded, programme } of index.titles) {
    if (programme.stop <= at || programme.start >= until || !showing.has(guideId)) continue;
    const match = found.get(guideId);
    const onNow = programme.start <= at;
    // A guide channel's titles come in time order, so its first later match is the earliest.
    if (onNow ? match?.now : match?.later) continue;
    if (!words.every((word) => folded.includes(word))) continue;
    found.set(
      guideId,
      onNow
        ? { now: true, later: match?.later ?? null }
        : { now: match?.now ?? false, later: { start: programme.start, title: programme.title } },
    );
  }
  const result: Record<string, ListingMatch> = {};
  for (const [guideId, match] of found) {
    for (const channelId of showing.get(guideId) ?? []) result[channelId] = match;
  }
  return result;
}

/**
 * How many of the viewer's mappings lead nowhere: the provider no longer lists the channel, or
 * the guide no longer lists the guide channel it was mapped to.
 */
export function unresolvedMappings(index: ProgrammeIndex | null, channels: MappedChannels): number {
  let count = channels.unlisted.size;
  if (!index) return count;
  for (const guideId of channels.mapped.values()) if (!index.channels.has(guideId)) count++;
  return count;
}

/** One of a catalogue's channels as the mapping list shows it. */
export function mapChannel(
  index: ProgrammeIndex,
  channels: MappedChannels,
  channel: LiveChannel,
): MapChannel {
  return {
    id: channel.id,
    number: channel.number,
    title: channel.title,
    guideId: shownGuideId(index, channels, channel.id) ?? null,
    mappedTo: channels.mapped.get(channel.id) ?? null,
    listed: true,
  };
}

/**
 * A page of the catalogue's channels for the mapping list, in the lists' order: those without
 * programmes, those mapped by hand, or all, and of those the ones whose names have every word of
 * `query`, or whose number is one of them. Mapped channels the provider no longer lists come
 * last among the mapped ones, under the name they had.
 */
export function mapChannelsAt(
  index: ProgrammeIndex,
  channels: MappedChannels,
  { filter, query }: { readonly filter: MapFilter; readonly query: string },
  offset: number,
  limit: number,
): { readonly total: number; readonly channels: readonly MapChannel[] } {
  const words = searchWords(query);
  const found = (name: string, number: number | null) =>
    words.every((word) => name.includes(word) || String(number) === word);
  const rows: MapChannel[] = [];
  let total = 0;
  const take = (row: () => MapChannel) => {
    if (total >= offset && rows.length < limit) rows.push(row());
    total++;
  };
  for (const [at, channel] of channels.all.entries()) {
    if (!found(channels.searchNames[at] ?? "", channel.number)) continue;
    if (filter === "mapped" && !channels.mapped.has(channel.id)) continue;
    if (filter === "without" && shownGuideId(index, channels, channel.id) !== undefined) continue;
    take(() => mapChannel(index, channels, channel));
  }
  if (filter === "mapped") {
    for (const [id, mapping] of channels.unlisted) {
      if (!found(normalize(mapping.name), null)) continue;
      take(() => ({
        id,
        number: null,
        title: mapping.name,
        guideId: null,
        mappedTo: mapping.guideId,
        listed: false,
      }));
    }
  }
  return { total, channels: rows };
}

/** The guide's channels as its picker lists them, kept while the guide is the same one. */
const guideChannels = new WeakMap<
  ProgrammeIndex,
  readonly (GuideChannel & { readonly folded: string })[]
>();

/**
 * A page of the channels a guide lists, by name: all of them, or those whose name or id has
 * every word of `query`, with the ones that begin with it first. Each says whether the guide has
 * programmes for it; none of the programmes come along.
 */
export function guideChannelsAt(
  index: ProgrammeIndex,
  query: string,
  offset: number,
  limit: number,
): GuideChannelPage {
  let all = guideChannels.get(index);
  if (!all) {
    all = [...index.channels]
      .map(([id, { name, folded }]) => ({
        id,
        name,
        programmes: index.byChannel.has(id),
        folded,
      }))
      // By name, whatever its case and accents, then by id.
      .sort((a, b) => (a.folded < b.folded ? -1 : a.folded > b.folded ? 1 : 0));
    guideChannels.set(index, all);
  }
  const words = searchWords(query);
  const whole = words.join(" ");
  const matches =
    words.length === 0
      ? all
      : all
          .filter(({ folded }) => words.every((word) => folded.includes(word)))
          // The sort keeps the names' order within each half.
          .sort(
            (a, b) => Number(!a.folded.startsWith(whole)) - Number(!b.folded.startsWith(whole)),
          );
  return {
    total: matches.length,
    channels: matches
      .slice(offset, offset + limit)
      .map(({ id, name, programmes }) => ({ id, name, programmes })),
  };
}

function programmesOf(
  index: ProgrammeIndex,
  channels: GuideChannels,
  channelId: string,
): readonly Programme[] {
  const guideId = shownGuideId(index, channels, channelId);
  return (guideId && index.byChannel.get(guideId)) || [];
}

/**
 * The guide id whose programmes a channel shows: the first of its ids the guide has programmes
 * for. So a spelling the guide doesn't know never hides one it does, wherever the provider lists
 * it, and a channel shows, counts and is found once when the guide knows several.
 */
function shownGuideId(
  index: ProgrammeIndex,
  channels: GuideChannels,
  channelId: string,
): string | undefined {
  return channels.guideIdsOf(channelId).find((guideId) => index.byChannel.has(guideId));
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
