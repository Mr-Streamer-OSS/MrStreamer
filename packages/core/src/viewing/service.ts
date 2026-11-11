// The viewing record service: favourites, watch history, how far movies and episodes got and the
// episodes marked by hand, as events per account. Commands carry an id, so sending one again
// changes nothing more; the store appends a command's events and the state they add up to in one
// transaction, and the service tells the UI after the commit.
//
// Every channel and title a call names says which subscription it belongs to, and so does every
// one it answers with. The record keeps them per account by the provider's own ids, under the key
// the app gives a saved subscription. A call that names a subscription that isn't saved reads and
// changes nothing: what finishes after its subscription went never lands in another account's
// record.
//
// The lists it answers with are every saved subscription's at once: the favourites in the order
// they were starred, whichever subscription each is from, the channels watched by when they were
// watched, and Continue watching by when each title played. Each entry stays in its own account's
// record, so removing a subscription takes its entries out of the lists and nothing else, and
// what another build wrote for one account still reads as it wrote it.
//
// A film's mark is kept by each version marked, and an episode's by its series and its numbers,
// both apart from how far any file played (see ./marks.ts and ./episodes.ts). Which series that is,
// and which versions of it a subscription lists, the lists say when the mark is made and each time
// it is read: the UI names a version and never says what it belongs to. Where a marked series goes
// on is worked out each time the record is read, from how it stands then and the episodes the
// series listed when it was last marked, so it follows what a play saves afterwards and asks no
// provider. When the app reads those episodes again for its own ends, it tells the record what they
// are now.
//
// The app supplies five ports: which subscriptions are saved, the store, the lists kept in
// preferences.json before the record, which the first start imports once, the catalogues'
// channels, and what the lists and a series' details say of a series. The record keeps the
// provider's stream ids, as builds before channels with several
// streams did, and shows them by channel: a list holding two streams of one channel shows it once,
// by the channel's id. Nothing stored is rewritten, so those builds still read every list. A new
// order of the favourites is no exception: it is the same favourites, removed and added again.
// Which streams are one favourite is the channels port's `favourite` where the app gives one, as
// an app that remembers a channel's streams after its list drops some does; else the channel the
// catalogue lists now. Starring, unstarring, showing and ordering favourites all go by that one
// answer. Recent channels and watching go by the catalogue alone.
import type { ActiveProfile } from "@mrstreamer/contracts/profiles";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { seriesOf, type TitleRef } from "@mrstreamer/contracts/ondemand";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import {
  CONTINUE_OFFERED,
  RECENT_LIMIT,
  type EpisodeMark,
  type FavouriteOrder,
  type FilmMark,
  type HistoryEntry,
  type MarkedNext,
  type MarkMade,
  type MarkScope,
  type MarksChanged,
  type SeriesViewing,
  type TitleFilter,
  type TitleProgress,
  type Viewing,
} from "@mrstreamer/contracts/viewing";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { Failed } from "../failure.ts";
import { episodeStates } from "./episodes.ts";
import {
  filmState,
  leading,
  standing,
  stands,
  undoable,
  type SeriesIdentity,
  type SeriesMarks,
} from "./marks.ts";
import { removalScope, type RawProgress } from "./titles.ts";
import {
  decide,
  importEvents,
  reordered,
  type AccountEvent,
  type EpisodeTitle,
  type SeriesListing,
  type StoredChannel,
  type StoredFilmMark,
  type StoredMark,
  type ViewingCommand,
  type ViewingEvent,
  type ViewingState,
} from "./record.ts";
import { defined } from "../defined.ts";

/** A saved subscription as the record knows it. */
export interface ViewingOwner {
  /** What channels and titles name it by. */
  readonly subscriptionId: string;
  /** The account its record is kept under. Other builds read the same record by it. */
  readonly key: string;
  /** The subscription older releases know: the lists preferences.json kept were its account's. */
  readonly original: boolean;
  /** Rechecks this saved source inside a write's transaction when roster reads can wait. */
  readonly stands?: () => boolean;
}

/** Which subscriptions are saved, in their order, also while a secret can't be read. */
export class ViewingAccount extends Context.Service<
  ViewingAccount,
  { readonly owners: Effect.Effect<readonly ViewingOwner[]> }
>()("mrstreamer/ViewingAccount") {}

/** A subscription's channels, to show its lists by channel. */
export class ViewingChannels extends Context.Service<
  ViewingChannels,
  {
    /**
     * Finds a subscription's channels by their id or any of their streams'. None without its
     * catalogue, so a change to one subscription's record never goes by another's channels.
     */
    readonly lookup: (
      subscriptionId: string,
    ) => Effect.Effect<(channelId: string) => LiveChannel | undefined>;
    /**
     * Which favourite a saved stream id of the subscription is: the streams starred, unstarred
     * and moved together, and the id it shows by. Only favourites read it. Without it, each is
     * the channel `lookup` finds now, with its streams.
     */
    readonly favourite?: (
      subscriptionId: string,
    ) => Effect.Effect<(streamId: string) => FavouriteGroup | undefined>;
  }
>()("mrstreamer/ViewingChannels") {}

/** One favourite as the channels port names it: by ids alone, nothing to play. */
export interface FavouriteGroup {
  /** What the favourite shows by: the channel's id, or one of its streams' while none is listed. */
  readonly id: string;
  /** Every stream id of it the record may hold, `id` among them. */
  readonly streamIds: readonly string[];
}

/** An episode of a series, in one subscription. */
export type EpisodeRef = Extract<TitleRef, { readonly kind: "episode" }>;

/** The seasons a series version lists, each with its episodes in order. */
export type SeriesSeasons = readonly {
  readonly number: number;
  readonly episodes: readonly {
    readonly id: string;
    readonly season: number;
    readonly number: number;
    readonly exactVersion?: true;
    readonly versions?: readonly { readonly id: string }[];
  }[];
}[];

/** What the lists and a series' details say of a series, which its marks go by. */
export class ViewingSeries extends Context.Service<
  ViewingSeries,
  {
    /** What a series version is as the lists have it now. Asks no provider. */
    readonly identity: (series: OwnedId) => Effect.Effect<SeriesIdentity, Failed>;
    /** Current identities in input order, from one catalogue read. Older adapters use identity. */
    readonly identities?: (
      series: readonly OwnedId[],
    ) => Effect.Effect<readonly SeriesIdentity[], Failed>;
    /** The seasons that version lists: what its details hold, as when its sheet opened. */
    readonly seasons: (series: OwnedId) => Effect.Effect<SeriesSeasons, Failed>;
  }
>()("mrstreamer/ViewingSeries") {}

/** The records of some accounts read as one, and how far they have come. */
export interface StoredViewing {
  /** Stream ids in the order they were starred, or the order the viewer gave them since. */
  readonly favourites: readonly StoredChannel[];
  /** Stream ids, most recently watched first: each account's own most recent ones. */
  readonly recent: readonly StoredChannel[];
  /** Worked out from each account's title rows, most recent first; see ./titles.ts. */
  readonly continueWatching: readonly {
    readonly account: string;
    readonly progress: RawProgress;
  }[];
  readonly recentTitles?: StoredViewing["continueWatching"];
  /**
   * For each marked series, its latest mark and where it goes on as its record stands (`goesOn`
   * in ./marks.ts), unless the series left Continue watching since. Most recent first.
   */
  readonly marked: readonly {
    readonly account: string;
    readonly mark: StoredMark;
    readonly next: MarkedNext | null;
  }[];
  /** A later change to any of the accounts has a higher number. */
  readonly sequence: number;
}

/** What a change reads of an account's record as it commits, in its transaction. */
export interface StoredLook {
  readonly titles: (account: string, filter: RawTitleFilter) => readonly RawProgress[];
  /** What is kept under each of a series' keys (`SeriesIdentity.keys`) that holds marks. */
  readonly marks: (account: string, keys: readonly string[]) => readonly SeriesMarks[];
  /** The marks of every series that listed one of these versions when it was last marked. */
  readonly marksIn: (account: string, seriesIds: readonly string[]) => readonly StoredMark[];
  /** The marks of those of these movies that have one, by the provider's ids. */
  readonly films: (account: string, movieIds: readonly string[]) => readonly StoredFilmMark[];
}

/** What an account's viewing history is made of, as stored: each in no particular order. */
export interface StoredHistory {
  /** Every movie's row, and the latest episode row of each series version. */
  readonly rows: readonly RawProgress[];
  /** Every movie's mark. */
  readonly films: readonly StoredFilmMark[];
  /** The latest mark kept under each key series' marks are kept under. */
  readonly series: readonly StoredMark[];
}

/**
 * Which of an account's titles to read: movies by the provider's id, and every episode of the
 * series by id, each language version of a film or series having its own.
 */
export interface RawTitleFilter {
  readonly movieIds?: readonly string[];
  readonly seriesIds?: readonly string[];
}

/** Where the events and the state they add up to are kept. */
/** Immutable desktop owner; native/default callers keep the ordinary changes stream. */
export class ViewingProfile extends Context.Service<ViewingProfile, ActiveProfile>()(
  "mrstreamer/ViewingProfile",
) {}

/** The source generations captured by a desktop profile admission, before any async work. */
export class ViewingErasure extends Context.Service<
  ViewingErasure,
  {
    readonly current: (account: string) => boolean;
  }
>()("mrstreamer/ViewingErasure") {}

export class ViewingStore extends Context.Service<
  ViewingStore,
  {
    /**
     * The records of `accounts` as one: an entry of an account named earlier comes first where
     * two got their places at once.
     */
    readonly read: (accounts: readonly string[]) => Effect.Effect<StoredViewing, Failed>;
    /** How far the titles matching `filter` got for `account`. */
    readonly titles: (
      account: string,
      filter: RawTitleFilter,
    ) => Effect.Effect<readonly RawProgress[], Failed>;
    /** What `account` keeps under each of a series' keys that holds marks. */
    readonly marks: (
      account: string,
      keys: readonly string[],
    ) => Effect.Effect<readonly SeriesMarks[], Failed>;
    /** Its marks of every series that listed one of these versions when it was last marked. */
    readonly marksIn: (
      account: string,
      seriesIds: readonly string[],
    ) => Effect.Effect<readonly StoredMark[], Failed>;
    /** Its marks of those of these movies that have one. */
    readonly films: (
      account: string,
      movieIds: readonly string[],
    ) => Effect.Effect<readonly StoredFilmMark[], Failed>;
    /** Everything `account` played or marked, for its history. */
    readonly history: (account: string) => Effect.Effect<StoredHistory, Failed>;
    /**
     * In one transaction: unless `commandId` ran before, appends the events `decide` makes from
     * the records of `accounts` as they stand, each to its own account's and in the order given,
     * and stores the states they add up to. Returns the records after, with the numbers the
     * events were given, in their order, and the original events for receipt recovery. A `Failed` from
     * `decide` refuses the command: the call fails with it and stores nothing, the id neither.
     */
    readonly commit: (input: {
      readonly accounts: readonly string[];
      readonly commandId: string;
      readonly at: number;
      /** Checked inside the transaction before receipt lookup, including idempotent retries. */
      readonly current?: () => boolean;
      readonly decide: (
        stored: StoredViewing,
        look: StoredLook,
      ) => readonly AccountEvent[] | Failed;
    }) => Effect.Effect<
      StoredViewing & {
        readonly written: readonly number[];
        readonly recorded: readonly (AccountEvent & { readonly sequence: number })[];
      },
      Failed
    >;
    /**
     * In one transaction with the import marker: appends `events` for `account`. Does nothing,
     * and returns false, once the marker is set.
     */
    readonly importOnce: (input: {
      readonly account: string | null;
      readonly at: number;
      readonly events: readonly ViewingEvent[];
    }) => Effect.Effect<boolean, Failed>;
    /** Deletes `account`'s events with everything worked out from them, so nothing can return. */
    readonly erase: (account: string) => Effect.Effect<void, Failed>;
  }
>()("mrstreamer/ViewingStore") {}

/** Lists kept in preferences.json before the record: read once, then removed from the file. */
export class LegacyViewing extends Context.Service<
  LegacyViewing,
  {
    /** The lists, or null when the file has none. */
    readonly take: Effect.Effect<{
      readonly favourites: readonly string[];
      readonly recent: readonly string[];
    } | null>;
    readonly drop: Effect.Effect<void>;
  }
>()("mrstreamer/LegacyViewing") {}

export class ViewingRecord extends Context.Service<
  ViewingRecord,
  {
    /** Every saved subscription's favourites, recent channels and titles; empty without one. */
    readonly state: Effect.Effect<Viewing, Failed>;
    /**
     * Stars or unstars a channel, by its id or any of its streams', with all its streams. Fails
     * with `no-subscription`, as every change to a channel or title does, when its subscription
     * isn't saved.
     */
    setFavourite(
      commandId: string,
      channel: OwnedId,
      favourite: boolean,
    ): Effect.Effect<Viewing, Failed>;
    /**
     * Puts the favourites in another order, whichever subscriptions they are of. Each channel
     * moves with every stream of it that is stored, and the favourites the order leaves out keep
     * their places. Fails with `favourites-changed` when the favourites no longer show as
     * `order.original` by what is stored and saved as the change commits: a favourite starred or
     * unstarred since, a channel's streams joined or split, or a subscription with favourites
     * gone. Adds and removes none.
     */
    reorderFavourites(commandId: string, order: FavouriteOrder): Effect.Effect<Viewing, Failed>;
    /** Puts a channel first among those watched recently, by its own id. */
    recordWatch(commandId: string, channel: OwnedId): Effect.Effect<Viewing, Failed>;
    /**
     * Remembers how far a movie or episode played, in a play that began at `since`, in the record
     * of the subscription the title names. One that arrives from a play older than the one last
     * recorded for the title, or from a play begun no later than its episode was last marked by
     * hand, is noted and changes nothing else: see `accepted` in ./titles.ts.
     */
    recordProgress(
      commandId: string,
      title: TitleRef,
      position: number,
      duration: number,
      since: number,
    ): Effect.Effect<Viewing, Failed>;
    /**
     * Takes movies and series out of Continue watching by their versions, every version played at
     * once, each in the record of the subscription that lists it, until a play begun afterwards.
     * How far they got stays.
     */
    removeFromContinue(commandId: string, titles: TitleFilter): Effect.Effect<Viewing, Failed>;
    /**
     * Records that a play watched a series to its end, with no episode left to go on with, by
     * the series' versions: every version played leaves Continue watching, as a removal does,
     * until a play begun afterwards. `since` is when that play began: in a subscription that
     * marked an episode of the series during it or after it, this changes nothing, and where the
     * series goes on is what its marks say.
     */
    finishSeries(
      commandId: string,
      series: readonly OwnedId[],
      since: number,
    ): Effect.Effect<Viewing, Failed>;
    /**
     * How far the matching titles got, each in its own subscription's record. Titles of a
     * subscription that isn't saved have none.
     */
    progress(titles: TitleFilter): Effect.Effect<readonly TitleProgress[], Failed>;
    /**
     * How the episodes of a series stand in the subscription of the version named: how far the
     * files of every version that subscription lists got, the marks that hold for the series as
     * the lists show it now, and the mark `undoMark` would still take back. None for a
     * subscription that isn't saved. Fails with whatever kept the lists or the record from
     * answering, and never answers as if nothing were played or marked.
     */
    episodes(series: OwnedId): Effect.Effect<SeriesViewing, Failed>;
    /**
     * Marks an episode watched or unwatched, in the record of the subscription it names, with
     * the episodes its series version lists, which say where the series goes on. Nothing of how
     * far its file played is changed, no length is made up, and nothing is asked of what plays.
     * Marking it as it is already marked changes nothing. Answers the mark as it stands, or null
     * once it was taken back.
     *
     * Fails, storing nothing, with `title-not-found` when the series version doesn't list the
     * episode, and with whatever kept the lists or the details from answering.
     */
    markEpisode(
      commandId: string,
      episode: EpisodeRef,
      watched: boolean,
    ): Effect.Effect<EpisodeMark | null, Failed>;
    /**
     * Takes back the mark of a series that `revision` names: its episode, with how far it had
     * got, where the series goes on and whether it shows in Continue watching are as before it.
     * Fails with `mark-changed`, changing nothing, unless that mark is still the series' latest
     * and no play of the series began after it: checked in the transaction that takes it back.
     */
    undoMark(commandId: string, series: OwnedId, revision: number): Effect.Effect<void, Failed>;
    /**
     * Marks what `scope` names watched or unwatched, all in one save, each film version and
     * series in the record of its own subscription. Leaves out the films and episodes that already
     * stand so, by their marks or their plays, and changes nothing of how far any file played.
     * Answers how many it changed and what Undo takes back.
     *
     * Fails, storing nothing, with `no-subscription` when a version's subscription isn't saved,
     * with `title-not-found` when the series doesn't list the season, and with whatever kept the
     * lists or the details from answering. A command sent again changes nothing more, and answers
     * with its original changed count and Undo receipt.
     */
    markTitles(
      commandId: string,
      scope: MarkScope,
      watched: boolean,
    ): Effect.Effect<MarksChanged, Failed>;
    /**
     * Takes back every mark `made` names at once: each film and episode, where its series goes on
     * and whether it shows in Continue watching are as before. Fails with `mark-changed`, changing
     * nothing, unless each is still its film's or series' latest mark, no play of it began after
     * it and it didn't leave Continue watching since: checked in the transaction that takes them
     * back. Marks of another profile's record are not found in this one, and fail alike.
     */
    undoMarks(commandId: string, made: readonly MarkMade[]): Effect.Effect<void, Failed>;
    /**
     * The marks of these movies that still stand, no play of them having begun after: by their
     * versions, each in its own subscription's record. None for a subscription that isn't saved.
     */
    filmMarks(movies: readonly OwnedId[]): Effect.Effect<readonly FilmMark[], Failed>;
    /**
     * Every film and series version the saved subscriptions played or marked, most recent first,
     * each in its own: removing one from Continue watching leaves it here.
     */
    readonly history: Effect.Effect<readonly HistoryEntry[], Failed>;
    /**
     * Notes the episodes a series version lists now, as its details were just read, and the
     * versions its subscription lists of the series: where a series last marked in that version
     * goes on is worked out from them from then on. Changes nothing for a series without marks,
     * for one last marked in another version, whose episodes are its own, for one that lists
     * what it did, and for details that list no episode.
     */
    relist(commandId: string, series: OwnedId, seasons: SeriesSeasons): Effect.Effect<void, Failed>;
    /**
     * Deletes everything `account` recorded, saved or not: favourites, watched channels, how far
     * titles got, the episodes it marked and what left Continue watching. Other accounts keep
     * theirs.
     */
    erase(account: string): Effect.Effect<void, Failed>;
    /** The sequence after each committed change. */
    readonly changes: Stream.Stream<number>;
    readonly profileChanges?: Stream.Stream<{
      readonly owner: ActiveProfile | null;
      readonly sequence: number;
    }>;
  }
>()("mrstreamer/ViewingRecord") {
  static readonly layer = Layer.effect(ViewingRecord, make());
}

const none: Viewing = {
  favourites: [],
  recent: [],
  continueWatching: [],
  marked: [],
  sequence: 0,
};

type ChannelOf = (channelId: string) => LiveChannel | undefined;

type FavouriteOf = (streamId: string) => FavouriteGroup | undefined;

/** Favourites as the catalogue alone groups them: each the channel listed now, with its streams. */
const byChannel =
  (channelOf: ChannelOf): FavouriteOf =>
  (streamId) => {
    const channel = channelOf(streamId);

    return (
      channel && {
        id: channel.id,
        streamIds: [channel.id, ...channel.variants.map(({ id }) => id)],
      }
    );
  };

/** The saved subscriptions and their channels, as a change or a read finds them. */
interface Saved {
  readonly owners: readonly ViewingOwner[];
  /** The owner of a record, by its account. */
  readonly ofAccount: ReadonlyMap<string, ViewingOwner>;
  /** A subscription's channels, by its id. */
  readonly channelsOf: ReadonlyMap<string, ChannelOf>;
  /** Which favourite each of a subscription's stream ids is, by its id. */
  readonly favouritesOf: ReadonlyMap<string, FavouriteOf>;
}

/** The records as a change finds them when it commits, with whose they are. */
interface Found extends Saved {
  readonly stored: StoredViewing;
}

const changed = new Failed({ error: { kind: "favourites-changed" } });
const markChanged = new Failed({ error: { kind: "mark-changed" } });
const noSubscription = new Failed({ error: { kind: "no-subscription" } });

/** A mark as the UI reads it: without what the record keeps beside it. */
function markOf({ season, episode, watched, at, revision }: StoredMark): EpisodeMark {
  return { season, episode, watched, at, revision };
}

/** A movie's mark as the UI reads it, in `owner`'s subscription. */
function filmMarkOf(
  owner: ViewingOwner,
  { title, watched, at, revision }: StoredFilmMark,
): FilmMark {
  return { movie: { subscriptionId: owner.subscriptionId, id: title.id }, watched, at, revision };
}

/**
 * An account's history, in `owner`'s subscription: one entry per movie and series version, by
 * when it was last played or marked. A movie's mark shows while it stands.
 */
function historyOf(owner: ViewingOwner, stored: StoredHistory): HistoryEntry[] {
  const { subscriptionId } = owner;
  const own = (id: string): OwnedId => ({ subscriptionId, id });

  const later = <A extends { readonly at: number }>(a: A | undefined, b: A) =>
    a && a.at >= b.at ? a : b;

  const movies = new Map<string, { progress?: RawProgress; mark?: StoredFilmMark }>();
  const series = new Map<string, { progress?: RawProgress; mark?: StoredMark }>();

  for (const row of stored.rows) {
    const { title } = row;

    if (title.kind === "movie") movies.set(title.id, { progress: row });
    else {
      const entry = series.get(title.seriesId);
      series.set(title.seriesId, { progress: later(entry?.progress, row) });
    }
  }

  for (const mark of stored.films)
    movies.set(mark.title.id, { ...movies.get(mark.title.id), mark });

  for (const mark of stored.series) {
    const entry = series.get(mark.title.seriesId) ?? {};
    series.set(mark.title.seriesId, { ...entry, mark: later(entry.mark, mark) });
  }

  const at = (...times: (number | undefined)[]) =>
    Math.max(...times.filter((time) => time !== undefined));

  return [
    ...[...movies].map(([id, { progress, mark }]): HistoryEntry => ({
      kind: "movie",
      movie: own(id),
      progress: progress ? progressOf(owner, progress) : null,
      mark: mark && stands(mark, progress) ? filmMarkOf(owner, mark) : null,
      at: at(progress?.at, mark?.at),
    })),
    ...[...series].map(([id, { progress, mark }]): HistoryEntry => ({
      kind: "series",
      series: own(id),
      progress: progress ? progressOf(owner, progress) : null,
      mark: mark ? markOf(mark) : null,
      at: at(progress?.at, mark?.at),
    })),
  ];
}

/** How far a title got, named with `owner`'s subscription. */
function progressOf(owner: ViewingOwner, progress: RawProgress): TitleProgress {
  return { ...progress, title: { ...progress.title, subscriptionId: owner.subscriptionId } };
}

/** An episode as a series version lists it. */
type ListedEpisode = SeriesSeasons[number]["episodes"][number];

/**
 * The episodes of `season`, or of every season when null, one per number: the first file listed
 * for it, with the episode a mark of it names.
 */
function episodesIn(
  seasons: SeriesSeasons,
  series: OwnedId,
  season: number | null,
): (ListedEpisode & { readonly title: EpisodeTitle })[] {
  const found = new Map<string, ListedEpisode & { readonly title: EpisodeTitle }>();

  for (const listed of seasons) {
    if (season !== null && listed.number !== season) continue;

    for (const episode of listed.episodes) {
      const key = `${listed.number}:${episode.number}`;

      if (found.has(key)) continue;

      const title: EpisodeTitle = {
        kind: "episode",
        id: episode.id,
        seriesId: series.id,
        season: listed.number,
        episode: episode.number,
      };

      found.set(key, { ...episode, title });
    }
  }

  return [...found.values()];
}

/** Logical episodes in source order, with current exact files for playlist progress. */
function listingOf(seasons: SeriesSeasons): SeriesListing {
  return seasons.map((season) => ({
    number: season.number,
    episodes: [...new Set(season.episodes.map((each) => each.number))],
    ...defined({
      files: season.episodes.some((episode) => episode.exactVersion)
        ? [
            ...new Set(
              season.episodes.flatMap((episode) => [
                episode.id,
                ...(episode.versions?.map((file) => file.id) ?? []),
              ]),
            ),
          ]
        : undefined,
    }),
  }));
}

/**
 * The keys of a series' marks that go on in the version `seriesId` and list other episodes, or
 * other versions, than `now`.
 */
function relisted(
  kept: readonly SeriesMarks[],
  seriesId: string,
  now: { readonly versions: readonly string[]; readonly listing: SeriesListing },
): string[] {
  // The versions in whatever order: the lists put the one that suits the viewer best in front.
  const said = (each: typeof now) => JSON.stringify([each.versions.toSorted(), each.listing]);

  return kept.flatMap((state) => {
    const last = leading(state);

    return last?.title.seriesId === seriesId && said(state) !== said(now) ? [last.series] : [];
  });
}

/** Every title a filter names. */
function namedIn(filter: TitleFilter): readonly OwnedId[] {
  return [...(filter.movies ?? []), ...(filter.series ?? [])];
}

/**
 * A stored channel as the lists show it, in its subscription: by its channel's id among recent
 * channels (`channelsOf`), by its favourite's among favourites (`favouritesOf`), else its own.
 */
function shownAs(
  saved: Saved,
  { account, id }: StoredChannel,
  by: "channelsOf" | "favouritesOf",
): OwnedId | null {
  const owner = saved.ofAccount.get(account);

  if (!owner) return null;
  const { subscriptionId } = owner;

  return { subscriptionId, id: saved[by].get(subscriptionId)?.(id)?.id ?? id };
}

/** One account's lists, out of the records read as one. */
function stateOf(stored: StoredViewing, { key }: ViewingOwner): ViewingState {
  const own = (list: readonly StoredChannel[]) =>
    list.flatMap(({ account, id }) => (account === key ? [id] : []));

  return { favourites: own(stored.favourites), recent: own(stored.recent) };
}

/** A command's events for `owner`, from its record as stored. */
function eventsOf(found: Found, owner: ViewingOwner, command: ViewingCommand): AccountEvent[] {
  return decide(stateOf(found.stored, owner), command).map((event) => ({
    account: owner.key,
    event,
  }));
}

/**
 * The events that put the stored favourites in the order asked for, or `changed` when they no
 * longer show as the list the order was made from. Ids a catalogue doesn't know are each their
 * own channel, as they show.
 */
function rearranged(found: Found, { original, order }: FavouriteOrder): AccountEvent[] | Failed {
  const streams = new Map<string, StoredChannel[]>();

  for (const stream of found.stored.favourites) {
    const channel = shownAs(found, stream, "favouritesOf");

    if (!channel) continue;
    const key = ownedKey(channel);
    const stored = streams.get(key);

    if (stored) stored.push(stream);
    else streams.set(key, [stream]);
  }

  const shown = [...streams.keys()];
  const listed = original.map(ownedKey);

  if (shown.length !== listed.length || shown.some((key, at) => key !== listed[at])) {
    return changed;
  }

  const wanted = order.map(ownedKey);
  // The channels arranged take one another's places; every other favourite stays in its own.
  const arranged = new Set(wanted);
  let next = 0;
  const placed = shown.map((key) => (arranged.has(key) ? (wanted[next++] ?? key) : key));

  // An order that changes nothing leaves the stored ids as they are, a channel's streams apart
  // from one another included.
  if (placed.every((key, at) => key === shown[at])) return [];

  return reordered(
    found.stored.favourites,
    placed.flatMap((key) => streams.get(key) ?? []),
  );
}

function make() {
  return Effect.gen(function* () {
    const account = yield* ViewingAccount;
    const channels = yield* ViewingChannels;
    const store = yield* ViewingStore;
    const legacy = yield* LegacyViewing;
    const listed = yield* ViewingSeries;
    const changes = yield* PubSub.unbounded<number>();

    const profileChanges = yield* PubSub.unbounded<{
      readonly owner: ActiveProfile | null;
      readonly sequence: number;
    }>();

    // The first start with the record brings in the lists preferences.json kept, which were the
    // original subscription's. The file loses them only after the import commits; a retry after a
    // crash finds the marker and imports nothing twice. Lists wait for an account to import into.
    yield* Effect.gen(function* () {
      const lists = yield* legacy.take;
      const key = (yield* account.owners).find((owner) => owner.original)?.key ?? null;

      if (lists && !key) return;
      yield* store.importOnce({
        account: key,
        at: yield* Clock.currentTimeMillis,
        events: lists ? importEvents(lists) : [],
      });
      yield* legacy.drop;
    }).pipe(
      Effect.catchTag("Failed", (failure) =>
        Effect.logWarning("[viewing] import failed; trying again next start", failure.error),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("[viewing] import failed; trying again next start", defect),
      ),
    );

    /** The saved subscriptions with their channels. Finding those can take a read from disk. */
    const saved = Effect.gen(function* () {
      const owners = yield* account.owners;

      const lookups = yield* Effect.forEach(owners, ({ subscriptionId }) =>
        Effect.gen(function* () {
          const channelOf = yield* channels.lookup(subscriptionId);

          const favouriteOf = channels.favourite
            ? yield* channels.favourite(subscriptionId)
            : byChannel(channelOf);

          return { subscriptionId, channelOf, favouriteOf };
        }),
      );

      return {
        owners,
        ofAccount: new Map(owners.map((owner) => [owner.key, owner])),
        channelsOf: new Map(lookups.map((each) => [each.subscriptionId, each.channelOf])),
        favouritesOf: new Map(lookups.map((each) => [each.subscriptionId, each.favouriteOf])),
      } satisfies Saved;
    });

    /**
     * The same, with nothing left to wait for: read again while a subscription came or went as
     * the channels were found, so what follows at once goes by the subscriptions saved then.
     */
    const settled = Effect.gen(function* () {
      let found = yield* saved;

      while (!sameOwners(yield* account.owners, found.owners)) found = yield* saved;

      return found;
    });

    /** A title as the account's record keeps it: by the provider's ids alone. */
    const rawTitle = ({ subscriptionId: _owner, ...raw }: TitleRef) => raw;

    /** `filter` as the store reads it for `owner`: the ids of the titles that are its own. */
    const rawFilter = (filter: TitleFilter, owner: ViewingOwner): RawTitleFilter => {
      const own = (titles: readonly OwnedId[] = []) =>
        titles.flatMap(({ subscriptionId, id }) =>
          subscriptionId === owner.subscriptionId ? [id] : [],
        );

      return { movieIds: own(filter.movies), seriesIds: own(filter.series) };
    };

    const shown = (found: Found): Viewing => {
      const listed = (list: readonly StoredChannel[], by: "channelsOf" | "favouritesOf") => [
        ...new Map(
          list.flatMap((stream) => {
            const channel = shownAs(found, stream, by);

            return channel ? [[ownedKey(channel), channel] as const] : [];
          }),
        ).values(),
      ];

      const { stored } = found;

      return {
        favourites: listed(stored.favourites, "favouritesOf"),
        recent: listed(stored.recent, "channelsOf").slice(0, RECENT_LIMIT),
        continueWatching: stored.continueWatching
          .flatMap(({ account, progress }) => {
            const owner = found.ofAccount.get(account);

            return owner ? [progressOf(owner, progress)] : [];
          })
          .slice(0, CONTINUE_OFFERED),
        marked: stored.marked
          .flatMap(({ account, mark, next }) => {
            const owner = found.ofAccount.get(account);

            if (!owner) return [];
            const series = { subscriptionId: owner.subscriptionId, id: mark.title.seriesId };

            return [{ series, kept: mark.series, at: mark.at, next }];
          })
          .slice(0, CONTINUE_OFFERED),
        recentTitles: (stored.recentTitles ?? [])
          .flatMap(({ account, progress }) => {
            const owner = found.ofAccount.get(account);

            return owner ? [progressOf(owner, progress)] : [];
          })
          .slice(0, 32),
        sequence: stored.sequence,
      };
    };

    /** The owners of `named`, each once, when every one of them is saved now. */
    const ownersOf = (
      owners: readonly ViewingOwner[],
      named: readonly { readonly subscriptionId: string }[],
    ) => {
      const wanted = new Set(named.map((each) => each.subscriptionId));
      const found = owners.filter((owner) => wanted.has(owner.subscriptionId));

      return found.length === wanted.size ? found : null;
    };

    /**
     * Commits the events `events` makes to the records of the saved subscriptions, from their
     * channels and from the records as stored when the change commits, or refuses with the
     * `Failed` it gives instead. `named` are what the change is about: it is refused with `gone`
     * unless the subscription of each is saved, when it arrives and again once the channels are
     * found. The transaction checks the named owners' presence again, so no change lands after
     * a removal erased their records, even if the last roster read answered an older snapshot.
     */
    const committed = (
      commandId: string,
      named: readonly { readonly subscriptionId: string }[],
      events: (
        found: Found,
        owners: readonly ViewingOwner[],
        look: StoredLook,
      ) => readonly AccountEvent[] | Failed,
      gone: Failed = noSubscription,
    ) =>
      Effect.gen(function* () {
        const erasure = yield* Effect.serviceOption(ViewingErasure);
        const initial = ownersOf(yield* account.owners, named);

        if (
          !initial ||
          (erasure._tag === "Some" && initial.some((owner) => !erasure.value.current(owner.key)))
        )
          return yield* gone;
        const found = yield* settled;
        const owners = ownersOf(found.owners, named);

        if (!owners) return yield* gone;
        const at = yield* Clock.currentTimeMillis;

        const stored = yield* store.commit({
          accounts: found.owners.map((owner) => owner.key),
          commandId,
          at,
          ...defined({
            current:
              erasure._tag === "Some"
                ? () => owners.every((owner) => erasure.value.current(owner.key))
                : undefined,
          }),
          decide: (stored, look) =>
            owners.some((owner) => owner.stands?.() === false)
              ? gone
              : events({ ...found, stored }, owners, look),
        });

        const owner = yield* Effect.serviceOption(ViewingProfile);
        yield* PubSub.publish(changes, stored.sequence);
        yield* PubSub.publish(profileChanges, {
          owner: owner._tag === "Some" ? owner.value : null,
          sequence: stored.sequence,
        });

        return { found, stored };
      });

    /** `committed`, answered with the records as the lists show them after. */
    const run = (...input: Parameters<typeof committed>) =>
      Effect.map(committed(...input), ({ found, stored }) => shown({ ...found, stored }));

    /** The saved owner of `title`'s subscription among `owners`, else `noSubscription`. */
    const ownerIn = (owners: readonly ViewingOwner[], title: { readonly subscriptionId: string }) =>
      owners.find((owner) => owner.subscriptionId === title.subscriptionId) ?? noSubscription;

    /** Commits mark events and recovers their original Undo receipt on retries. */
    const marking = (
      commandId: string,
      named: readonly OwnedId[],
      decide: (
        owners: readonly ViewingOwner[],
        look: StoredLook,
      ) => readonly AccountEvent[] | Failed,
    ) =>
      Effect.gen(function* () {
        const { stored } = yield* committed(commandId, named, (_found, owners, look) =>
          decide(owners, look),
        );

        // The store returns the original events on retries too, even after a restart.
        const owners = yield* account.owners;

        const made = stored.recorded.flatMap<{ count: number; mark: MarkMade }>(
          ({ account: key, event, sequence }) => {
            const owner = owners.find((each) => each.key === key);

            if (!owner) return [];

            if (event.type === "movie-marked")
              return [
                {
                  count: 1,
                  mark: {
                    kind: "movie" as const,
                    title: { subscriptionId: owner.subscriptionId, id: event.title.id },
                    revision: sequence,
                  },
                },
              ];
            const first = event.type === "episodes-marked" ? event.titles[0] : undefined;

            if (event.type === "episodes-marked" && first)
              return [
                {
                  count: event.titles.length,
                  mark: {
                    kind: "series" as const,
                    title: { subscriptionId: owner.subscriptionId, id: first.seriesId },
                    revision: sequence,
                  },
                },
              ];

            return [];
          },
        );

        return {
          changed: made.reduce((sum, each) => sum + each.count, 0),
          made: made.map((each) => each.mark),
        } satisfies MarksChanged;
      });

    /** Marks every version of a film watched or unwatched, each that doesn't stand so already. */
    const markFilm = (commandId: string, versions: readonly OwnedId[], watched: boolean) => {
      const wanted = watched ? "watched" : "unwatched";
      const unique = [...new Map(versions.map((each) => [ownedKey(each), each])).values()];

      return marking(commandId, unique, (owners, look) => {
        const made = [];

        for (const version of unique) {
          const owner = ownerIn(owners, version);

          if (owner instanceof Failed) return owner;
          const [mark] = look.films(owner.key, [version.id]);
          const [row] = look.titles(owner.key, { movieIds: [version.id] });

          if (filmState(mark, row) === wanted) continue;
          const title = { kind: "movie" as const, id: version.id };
          const event = { type: "movie-marked" as const, title, watched };
          made.push({ account: owner.key, event });
        }

        return made;
      });
    };

    /** Marks a season, or every episode a series lists, each that doesn't stand so already. */
    const markEpisodes = (
      commandId: string,
      series: OwnedId,
      season: number | null,
      watched: boolean,
    ) =>
      Effect.gen(function* () {
        // Asked first: the lists and the details can take a while.
        const { key, keys, versions } = yield* listed.identity(series);
        const seasons = yield* listed.seasons(series);
        const listing = listingOf(seasons);

        if (season !== null && !listing.some((each) => each.number === season)) {
          return yield* new Failed({ error: { kind: "title-not-found", titleId: series.id } });
        }

        const episodes = episodesIn(seasons, series, season);
        const wanted = watched ? "watched" : "unwatched";

        return yield* marking(commandId, [series], (owners, look) => {
          const owner = ownerIn(owners, series);

          if (owner instanceof Failed) return owner;

          const stateOf = episodeStates(
            look.titles(owner.key, { seriesIds: versions }),
            standing(look.marks(owner.key, keys)),
          );

          const titles = episodes.flatMap((each) =>
            stateOf(each).kind === wanted ? [] : [each.title],
          );

          if (titles.length === 0) return [];

          const event = {
            type: "episodes-marked" as const,
            series: key,
            titles,
            watched,
            versions,
            listing,
          };

          return [{ account: owner.key, event }];
        });
      });

    /**
     * The titles `filter` matches that their subscriptions played, by the account of each: each
     * movie, and one episode of each version of a series, which stands for the series. A series
     * that was marked counts as well, played or not, by an episode marked in it.
     */
    const playedIn = (filter: TitleFilter) =>
      Effect.gen(function* () {
        const owners = ownersOf(yield* account.owners, namedIn(filter));

        if (!owners) return yield* noSubscription;

        const played = yield* Effect.forEach(owners, (owner) =>
          Effect.gen(function* () {
            const own = rawFilter(filter, owner);

            const titles = [
              ...(yield* store.marksIn(owner.key, own.seriesIds ?? [])),
              ...(yield* store.titles(owner.key, own)),
            ].map(({ title }) => title);

            return [
              owner.key,
              [...new Map(titles.map((title) => [removalScope(title), title])).values()],
            ] as const;
          }),
        );

        return new Map(played);
      });

    /** Takes back every mark `made` names, all at once or none: see `ViewingRecord.undoMarks`. */
    const undoMarks = (commandId: string, made: readonly MarkMade[]) =>
      Effect.gen(function* () {
        // What each series is as the lists have it, asked before the transaction.
        const identities = yield* Effect.forEach(made, (each) =>
          each.kind === "series" ? listed.identity(each.title) : Effect.succeed(null),
        );

        yield* run(
          commandId,
          made.map(({ title }) => title),
          (_found, owners, look) => {
            const events: AccountEvent[] = [];

            for (const [at, each] of made.entries()) {
              const owner = ownerIn(owners, each.title);

              if (owner instanceof Failed) return owner;
              const identity = identities[at];

              if (!identity) {
                const [mark] = look.films(owner.key, [each.title.id]);
                const [row] = look.titles(owner.key, { movieIds: [each.title.id] });

                if (mark?.revision !== each.revision || !mark.undo || !stands(mark, row)) {
                  return markChanged;
                }

                const event = {
                  type: "movie-mark-undone" as const,
                  title: mark.title,
                  revision: mark.revision,
                };

                events.push({ account: owner.key, event });
                continue;
              }

              const mark = undoable(
                look.marks(owner.key, identity.keys),
                look.titles(owner.key, { seriesIds: identity.versions }),
              );

              if (mark?.revision !== each.revision) return markChanged;

              events.push({
                account: owner.key,
                event: {
                  type: "episode-mark-undone",
                  series: mark.series,
                  title: mark.title,
                  revision: mark.revision,
                },
              });
            }

            return events;
          },
        );
      });

    return {
      state: Effect.gen(function* () {
        // Catalogue lookups may have waited across a source removal.
        const found = yield* settled;

        if (found.owners.length === 0) return none;
        const stored = yield* store.read(found.owners.map((owner) => owner.key));

        return shown({ ...found, stored });
      }),
      setFavourite: (commandId: string, channel: OwnedId, favourite: boolean) =>
        run(commandId, [channel], (found, [owner]) => {
          if (!owner) return noSubscription;

          const ids = found.favouritesOf.get(owner.subscriptionId)?.(channel.id)?.streamIds ?? [
            channel.id,
          ];

          return eventsOf(found, owner, {
            kind: "set-favourite",
            channelIds: [...new Set(ids)],
            favourite,
          });
        }),
      reorderFavourites: (commandId: string, order: FavouriteOrder) => {
        const listed = new Set(order.original.map(ownedKey));
        const arranged = order.order.map(ownedKey);

        if (
          new Set(arranged).size !== arranged.length ||
          arranged.some((key) => !listed.has(key))
        ) {
          return Effect.fail(
            new Failed({
              error: {
                kind: "invalid-input",
                detail: "The order names a channel twice, or one that isn't a favourite.",
              },
            }),
          );
        }

        // An order for favourites of a subscription that went is one for a list that changed.
        return run(commandId, order.original, (found) => rearranged(found, order), changed);
      },
      recordWatch: (commandId: string, channel: OwnedId) =>
        run(commandId, [channel], (found, [owner]) =>
          owner
            ? eventsOf(found, owner, {
                kind: "record-watch",
                channelId:
                  found.channelsOf.get(owner.subscriptionId)?.(channel.id)?.id ?? channel.id,
              })
            : noSubscription,
        ),
      recordProgress: (
        commandId: string,
        title: TitleRef,
        position: number,
        duration: number,
        since: number,
      ) =>
        run(commandId, [title], (found, [owner]) =>
          owner
            ? eventsOf(found, owner, {
                kind: "record-progress",
                title: rawTitle(title),
                position,
                duration,
                since,
              })
            : noSubscription,
        ),
      removeFromContinue: (commandId: string, titles: TitleFilter) =>
        Effect.flatMap(playedIn(titles), (played) =>
          run(commandId, namedIn(titles), (found, owners) =>
            owners.flatMap((owner) =>
              eventsOf(found, owner, {
                kind: "remove-titles",
                titles: played.get(owner.key) ?? [],
              }),
            ),
          ),
        ),
      finishSeries: (commandId: string, series: readonly OwnedId[], since: number) =>
        Effect.flatMap(playedIn({ series }), (played) =>
          run(commandId, series, (found, owners, look) =>
            owners.flatMap((owner) => {
              // The word of a play the viewer marked an episode during, or after, comes too
              // late: where the series goes on is what its marks say.
              const marks = look.marksIn(owner.key, rawFilter({ series }, owner).seriesIds ?? []);

              if (marks.some((mark) => mark.at >= since)) return [];

              return eventsOf(found, owner, {
                kind: "finish-series",
                titles: played.get(owner.key) ?? [],
              });
            }),
          ),
        ),
      progress: (titles: TitleFilter) =>
        Effect.gen(function* () {
          const named = new Set(namedIn(titles).map((each) => each.subscriptionId));
          const owners = (yield* account.owners).filter((owner) => named.has(owner.subscriptionId));

          const played = yield* Effect.forEach(owners, (owner) =>
            Effect.map(store.titles(owner.key, rawFilter(titles, owner)), (rows) =>
              rows.map((progress) => progressOf(owner, progress)),
            ),
          );

          return played.flat();
        }),
      episodes: (series: OwnedId) =>
        Effect.gen(function* () {
          const owner = ownersOf(yield* account.owners, [series])?.[0];

          if (!owner) return { progress: [], marks: [], undoable: null };
          const { keys, versions } = yield* listed.identity(series);
          const played = yield* store.titles(owner.key, { seriesIds: versions });
          const kept = yield* store.marks(owner.key, keys);

          return {
            progress: played.map((progress) => progressOf(owner, progress)),
            marks: standing(kept).map(markOf),
            undoable: undoable(kept, played)?.revision ?? null,
          };
        }),
      markEpisode: (commandId: string, episode: EpisodeRef, watched: boolean) =>
        Effect.gen(function* () {
          const { subscriptionId: _owner, ...title } = episode;

          const same = (mark: { readonly season: number; readonly episode: number }) =>
            mark.season === title.season && mark.episode === title.episode;

          // Asked first: the lists and the details can take a while, and nothing of the record
          // is read until they answered.
          const { key, keys, versions } = yield* listed.identity(seriesOf(episode));
          const listing = listingOf(yield* listed.seasons(seriesOf(episode)));

          const lists = listing.some(
            (season) => season.number === title.season && season.episodes.includes(title.episode),
          );

          if (!lists) {
            return yield* new Failed({ error: { kind: "title-not-found", titleId: episode.id } });
          }

          yield* run(commandId, [episode], (_found, [owner], look) => {
            if (!owner) return noSubscription;
            const held = standing(look.marks(owner.key, keys)).find(same);

            const replayed = look
              .titles(owner.key, { seriesIds: versions })
              .some(
                (entry) =>
                  entry.title.kind === "episode" &&
                  same(entry.title) &&
                  entry.since > (held?.at ?? Infinity),
              );

            if (held?.watched === watched && !replayed) return [];

            return [
              {
                account: owner.key,
                event: { type: "episode-marked", series: key, title, watched, versions, listing },
              },
            ];
          });
          const owner = ownersOf(yield* account.owners, [episode])?.[0];
          const stored = owner ? standing(yield* store.marks(owner.key, keys)).find(same) : null;

          return stored ? markOf(stored) : null;
        }),
      undoMark: (commandId: string, series: OwnedId, revision: number) =>
        undoMarks(commandId, [{ kind: "series", title: series, revision }]),
      undoMarks,
      markTitles: (commandId: string, scope: MarkScope, watched: boolean) =>
        scope.kind === "film"
          ? markFilm(commandId, scope.versions, watched)
          : markEpisodes(
              commandId,
              scope.series,
              scope.kind === "season" ? scope.season : null,
              watched,
            ),
      filmMarks: (movies: readonly OwnedId[]) =>
        Effect.gen(function* () {
          const named = new Set(movies.map((each) => each.subscriptionId));
          const owners = (yield* account.owners).filter((owner) => named.has(owner.subscriptionId));

          const marks = yield* Effect.forEach(owners, (owner) =>
            Effect.gen(function* () {
              const ids = rawFilter({ movies }, owner).movieIds ?? [];
              const rows = yield* store.titles(owner.key, { movieIds: ids });
              const kept = yield* store.films(owner.key, ids);

              return kept.flatMap((mark) =>
                stands(
                  mark,
                  rows.find((row) => row.title.id === mark.title.id),
                )
                  ? [filmMarkOf(owner, mark)]
                  : [],
              );
            }),
          );

          return marks.flat();
        }),
      history: Effect.gen(function* () {
        const owners = yield* account.owners;

        const entries = yield* Effect.forEach(owners, (owner) =>
          Effect.gen(function* () {
            const entries = historyOf(owner, yield* store.history(owner.key));

            const series = entries.flatMap((entry) =>
              entry.kind === "series" ? [entry.series] : [],
            );

            const identities =
              series.length === 0
                ? []
                : yield* listed.identities
                    ? listed.identities(series)
                    : Effect.forEach(series, listed.identity);

            const byVersion = new Map(
              series.map((each, index) => [ownedKey(each), identities[index]]),
            );

            return yield* Effect.forEach(entries, (entry) =>
              Effect.gen(function* () {
                if (entry.kind === "movie") return entry;
                const identity = byVersion.get(ownedKey(entry.series));

                if (!identity)
                  return yield* new Failed({
                    error: {
                      kind: "unexpected",
                      detail: "Missing series identity; retry the request.",
                    },
                  });
                const played = yield* store.titles(owner.key, { seriesIds: identity.versions });
                const kept = yield* store.marks(owner.key, identity.keys);

                return { ...entry, undoable: undoable(kept, played)?.revision ?? null };
              }),
            );
          }),
        );

        return entries.flat().toSorted((a, b) => b.at - a.at);
      }),
      relist: (commandId: string, series: OwnedId, seasons: SeriesSeasons) =>
        Effect.gen(function* () {
          const listing = listingOf(seasons);
          const owner = ownersOf(yield* account.owners, [series])?.[0];

          if (!owner || !listing.some((season) => season.episodes.length > 0)) return;
          const { keys, versions } = yield* listed.identity(series);
          const now = { versions, listing };
          // Read first: most details read are of a series that lists what it did, or has no marks.
          const stale = relisted(yield* store.marks(owner.key, keys), series.id, now);

          if (stale.length === 0) return;
          yield* run(commandId, [series], (_found, [mine], look) =>
            mine
              ? relisted(look.marks(mine.key, keys), series.id, now).map((key) => ({
                  account: mine.key,
                  event: { type: "series-listed", series: key, ...now },
                }))
              : noSubscription,
          );
        }),
      erase: (key: string) => store.erase(key),
      changes: Stream.fromPubSub(changes),
      profileChanges: Stream.fromPubSub(profileChanges),
    };
  });
}

/** Whether the same subscriptions are saved, under the same accounts, in the same order. */
function sameOwners(a: readonly ViewingOwner[], b: readonly ViewingOwner[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (owner, at) => owner.subscriptionId === b[at]?.subscriptionId && owner.key === b[at]?.key,
    )
  );
}
