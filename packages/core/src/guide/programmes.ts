// The programme guide in memory: programmes per guide channel, and the lookups the UI asks for.
// Built from an XMLTV document as it streams in, dropping programmes that already ended.
import type { Listing, ListingMatch, Programme, ProgrammeMatch } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { normalize, searchWords } from "../text.ts";
import { xmltvReader, type XmltvProgramme } from "./xmltv.ts";

/** How many programmes a search returns. */
export const SEARCH_LIMIT = 50;
/** Indexing pauses for other work after this many guide channels. */
const YIELD_EVERY_CHANNELS = 50;

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
}

/**
 * Indexes an XMLTV document, leaving out programmes that ended before `since`. Reads it chunk by
 * chunk and pauses between channels at the end, so no step holds the process for long. Fails when
 * the document lists no programmes at all.
 */
export async function indexProgrammes(
  document: AsyncIterable<Uint8Array>,
  since: number,
): Promise<ProgrammeIndex> {
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
  if (read === 0) throw new EmptyGuide();
  const byChannel = new Map<string, readonly Programme[]>();
  const titles: Titled[] = [];
  let done = 0;
  for (const [guideId, entries] of raw) {
    // Lets other work in between, every so many channels.
    if (++done % YIELD_EVERY_CHANNELS === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const programmes = timeline(entries).filter((programme) => programme.stop > since);
    if (programmes.length === 0) continue;
    byChannel.set(guideId, programmes);
    for (const programme of programmes) {
      titles.push({ guideId, folded: folded.get(programme.title) ?? "", programme });
    }
  }
  return { byChannel, titles };
}

/** A document without a single programme, which never replaces a guide. */
export class EmptyGuide extends Error {
  constructor() {
    super("The guide lists no programmes.");
  }
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
