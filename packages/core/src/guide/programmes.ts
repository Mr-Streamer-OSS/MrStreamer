// What the UI asks of a guide, over a subscription's catalogue: now and next for a screen of
// channels, a schedule, a page of a grid, searches, and the lists for mapping channels by hand.
// The programmes are read from the guide's index on disk (index-file.ts), a few at a time.
//
// A catalogue channel shows the programmes of the guide channel its own guide id names, when the
// guide has that id exactly; or of the one the viewer mapped it to by hand, which then counts
// alone. Nothing is ever matched by name. `mappedChannels` lays the viewer's mappings over a
// catalogue's guide ids, both ways, so every lookup here reads one and the same answer.
import type {
  GuideChannelPage,
  Listing,
  ListingMatch,
  MapChannel,
  MapFilter,
  Programme,
  ProgrammeMatch,
} from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { normalize, searchWords } from "../text.ts";
import type { FoundProgramme, GuideIndex, IndexedChannel } from "./index-file.ts";

/** How many programmes a search returns. */
export const SEARCH_LIMIT = 50;

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

/** What each channel shows now and next at `at`. Channels without guide data are left out. */
export function listingsAt(
  index: GuideIndex,
  channels: GuideChannels,
  channelIds: readonly string[],
  at: number,
): Record<string, Listing> {
  const result: Record<string, Listing> = {};
  for (const channelId of channelIds) {
    const shown = shownChannel(index, channels, channelId);
    const listing = shown && index.listing(shown, at);
    if (listing) result[channelId] = listing;
  }
  return result;
}

/** How many of the catalogue's channels the guide has programmes for. */
export function channelsCovered(index: GuideIndex, channels: GuideChannels): number {
  return remembered(covered, index, channels, () => {
    let count = 0;
    for (const { id, until } of index.channels.values()) {
      if (until === null) continue;
      for (const channel of channels.channelsOf(id)) {
        if (shownGuideId(index, channels, channel.id) === id) count++;
      }
    }
    return count;
  });
}

const covered = new WeakMap<GuideIndex, WeakMap<GuideChannels, number>>();

/** The channel's programme on now and everything after it that the guide knows. */
export function scheduleAt(
  index: GuideIndex,
  channels: GuideChannels,
  channelId: string,
  at: number,
): readonly Programme[] {
  const shown = shownChannel(index, channels, channelId);
  return shown ? index.schedule(shown, at) : [];
}

/**
 * Each channel's programmes that overlap [from, to), past ones the guide keeps among them, by
 * channel id. Channels without guide data are left out.
 */
export function rangeAt(
  index: GuideIndex,
  channels: GuideChannels,
  channelIds: readonly string[],
  from: number,
  to: number,
): Record<string, readonly Programme[]> {
  const result: Record<string, readonly Programme[]> = {};
  for (const channelId of channelIds) {
    const shown = shownChannel(index, channels, channelId);
    if (shown) result[channelId] = index.range(shown, from, to);
  }
  return result;
}

/**
 * Programmes on now or later whose title has every word of `query`, on the first channel in the
 * catalogue that shows them. On now comes first, then by start time.
 */
export async function searchAt(
  index: GuideIndex,
  channels: GuideChannels,
  query: string,
  at: number,
): Promise<readonly ProgrammeMatch[]> {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const shown = searchable(index, channels);
  /** The best found so far, best first: on now, then by start time. */
  const best: { readonly found: FoundProgramme; readonly channel: LiveChannel }[] = [];
  const rank = (found: FoundProgramme) => (found.start <= at ? 0 : 1);
  const before = (a: FoundProgramme, b: FoundProgramme) =>
    rank(a) - rank(b) || a.start - b.start || a.channel - b.channel;
  await index.matching(
    words,
    at,
    // Once fifty are in, only one that starts before the last of them can take its place.
    () => best.at(SEARCH_LIMIT - 1)?.found.start ?? Number.POSITIVE_INFINITY,
    (found) => {
      const channel = shown.get(found.channel);
      if (!channel) return;
      let place = best.length;
      while (place > 0 && before(found, best[place - 1]!.found) < 0) place--;
      if (place >= SEARCH_LIMIT) return;
      best.splice(place, 0, { found, channel });
      if (best.length > SEARCH_LIMIT) best.pop();
    },
  );
  return best.flatMap(({ found, channel }) => {
    const programme = index.programme(found);
    return programme ? [{ channel, programme }] : [];
  });
}

/**
 * The catalogue channel a search names for each guide channel the guide has programmes for:
 * the first that shows it, leaving out channels for adults, which show only in Live TV's lists.
 */
function searchable(index: GuideIndex, channels: GuideChannels): ReadonlyMap<number, LiveChannel> {
  return remembered(shownBy, index, channels, () => {
    const shown = new Map<number, LiveChannel>();
    for (const { key, id, until } of index.channels.values()) {
      if (until === null) continue;
      const channel = channels
        .channelsOf(id)
        .find((each) => !each.adult && shownGuideId(index, channels, each.id) === id);
      if (channel) shown.set(key, channel);
    }
    return shown;
  });
}

const shownBy = new WeakMap<GuideIndex, WeakMap<GuideChannels, ReadonlyMap<number, LiveChannel>>>();

/**
 * What a search for `query` finds in the programmes of `channelIds`, by channel id: whether the
 * one on now has every word in its title, and the first later one starting before `until` that
 * does. Channels without a match are left out. Every channel given is searched, on the guide id
 * it shows, so channels that share one are each found and nothing is cut off; those for adults
 * count like any other, as a list holds them only while the catalogue shows them.
 */
export async function searchChannelsAt(
  index: GuideIndex,
  channels: GuideChannels,
  channelIds: readonly string[],
  query: string,
  at: number,
  until: number,
): Promise<Record<string, ListingMatch>> {
  const words = searchWords(query);
  if (words.length === 0) return {};
  const showing = new Map<number, string[]>();
  for (const channelId of channelIds) {
    const shown = shownChannel(index, channels, channelId);
    if (!shown) continue;
    const ids = showing.get(shown.key);
    if (ids) ids.push(channelId);
    else showing.set(shown.key, [channelId]);
  }
  const found = new Map<number, { now: boolean; later: FoundProgramme | null }>();
  await index.matching(
    words,
    at,
    () => until,
    (programme) => {
      if (!showing.has(programme.channel)) return;
      const match = found.get(programme.channel) ?? { now: false, later: null };
      if (programme.start <= at) match.now = true;
      else if (!match.later || programme.start < match.later.start) match.later = programme;
      found.set(programme.channel, match);
    },
  );
  const result: Record<string, ListingMatch> = {};
  for (const [key, { now, later }] of found) {
    const match = { now, later: later && { start: later.start, title: later.title } };
    for (const channelId of showing.get(key) ?? []) result[channelId] = match;
  }
  return result;
}

/**
 * How many of the viewer's mappings lead nowhere: the provider no longer lists the channel, or
 * the guide no longer lists the guide channel it was mapped to.
 */
export function unresolvedMappings(index: GuideIndex | null, channels: MappedChannels): number {
  let count = channels.unlisted.size;
  if (!index) return count;
  for (const guideId of channels.mapped.values()) if (!index.channels.has(guideId)) count++;
  return count;
}

/** One of a catalogue's channels as the mapping list shows it. */
export function mapChannel(
  index: GuideIndex,
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
  index: GuideIndex,
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

/**
 * A page of the channels a guide lists, by name: all of them, or those whose name or id has
 * every word of `query`, with the ones that begin with it first. Each says whether the guide has
 * programmes for it; none of the programmes come along.
 */
export function guideChannelsAt(
  index: GuideIndex,
  query: string,
  offset: number,
  limit: number,
): GuideChannelPage {
  const words = searchWords(query);
  const whole = words.join(" ");
  const all = [...index.channels.values()];
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
      .map(({ id, name, until }) => ({ id, name, programmes: until !== null })),
  };
}

/**
 * The guide channel whose programmes a channel shows: the first of its ids the guide has
 * programmes for, past ones it keeps among them. So a spelling the guide doesn't know never
 * hides one it does, wherever the provider lists it, and a channel shows, counts and is found
 * once when the guide knows several.
 */
function shownChannel(
  index: GuideIndex,
  channels: GuideChannels,
  channelId: string,
): IndexedChannel | undefined {
  for (const guideId of channels.guideIdsOf(channelId)) {
    const channel = index.channels.get(guideId);
    if (channel && channel.until !== null) return channel;
  }
  return undefined;
}

function shownGuideId(
  index: GuideIndex,
  channels: GuideChannels,
  channelId: string,
): string | undefined {
  return shownChannel(index, channels, channelId)?.id;
}

/** What `work` makes of a guide and a catalogue's channels, kept while both are the same. */
function remembered<A>(
  cache: WeakMap<GuideIndex, WeakMap<GuideChannels, A>>,
  index: GuideIndex,
  channels: GuideChannels,
  work: () => A,
): A {
  let byChannels = cache.get(index);
  if (!byChannels) cache.set(index, (byChannels = new WeakMap()));
  const kept = byChannels.get(channels);
  if (kept !== undefined) return kept;
  const made = work();
  byChannels.set(channels, made);
  return made;
}
