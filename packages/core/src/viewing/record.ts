// The viewing record's rules: which events a command produces, and what the events add up to.
// Both are plain functions of their input. They never read the clock, fetch or make ids; the
// service supplies time and ids, and the store keeps the events and the state they add up to.
// How far movies and episodes got follows the rules in ./titles.ts, one row per title, and the
// films and episodes marked by hand those in ./marks.ts and ./episodes.ts, one row per film and
// episode. A state is one account's, by the provider's own ids: the service says which
// subscription's. Several accounts' lists read as one name each entry's account beside its id.
import type { RawTitleRef } from "@mrstreamer/contracts/ondemand";
import { RECENT_LIMIT, type EpisodeMark } from "@mrstreamer/contracts/viewing";

/** The version events are written with. Readers skip events from a newer version. */
export const EVENT_VERSION = 1;

/**
 * Rises when `apply`, `project` or the rules in ./titles.ts and ./marks.ts change, so stored state
 * is rebuilt from the events. 2: films marked by hand, and Undo of several episodes' marks at once.
 */
export const STATE_VERSION = 2;

/**
 * What happened, by meaning: not which button was pressed. Builds from before movies and series
 * skip the title events, as they skip any type they don't know.
 */
export type ViewingEvent =
  | { readonly type: "favourite-added"; readonly channelId: string }
  | { readonly type: "favourite-removed"; readonly channelId: string }
  | { readonly type: "watched"; readonly channelId: string }
  /**
   * A movie or episode played up to `position` of `duration` seconds, in a play that began at
   * `since`, epoch milliseconds. Builds before `since` wrote none: theirs read as a play begun when
   * the event was saved.
   */
  | {
      readonly type: "title-progress";
      readonly title: RawTitleRef;
      readonly position: number;
      readonly duration: number;
      readonly since: number;
    }
  /** Taken out of Continue watching: the movie, or the whole series of an episode. */
  | { readonly type: "title-removed"; readonly title: RawTitleRef }
  /**
   * The series of `title`, its last episode, watched to the end of what the provider lists. It
   * leaves Continue watching as a removal does.
   */
  | { readonly type: "series-finished"; readonly title: RawTitleRef }
  /**
   * The viewer marked an episode watched or unwatched by hand. It says nothing of how far a file
   * played, and names no length: the episode's own progress stays as it is, under the mark.
   * `series` is what the mark is kept under (`SeriesIdentity.key`) and `title` the episode in the
   * version it was marked in. `versions` are the provider's ids of the versions of the series
   * that subscription listed then, and `listing` the episodes that version listed: the events
   * hold neither otherwise, and where a marked series goes on is worked out from them. Builds
   * from before marks skip it.
   */
  | {
      readonly type: "episode-marked";
      readonly series: string;
      readonly title: EpisodeTitle;
      readonly watched: boolean;
      readonly versions: readonly string[];
      readonly listing: SeriesListing;
    }
  /**
   * The viewer marked some episodes of one series watched or unwatched at once, as a season or the
   * whole series: each as `episode-marked` would, all under one revision, which one Undo takes
   * back. `titles` are the episodes whose mark it changed, in the version they were marked in.
   * Builds from before it skip it, as they skip the Undo of it.
   */
  | {
      readonly type: "episodes-marked";
      readonly series: string;
      readonly titles: readonly EpisodeTitle[];
      readonly watched: boolean;
      readonly versions: readonly string[];
      readonly listing: SeriesListing;
    }
  /**
   * The mark of `series` that the event numbered `revision` made was taken back: its episodes, and
   * whether its series shows in Continue watching, are as before it. `title` is one of them.
   */
  | {
      readonly type: "episode-mark-undone";
      readonly series: string;
      readonly title: EpisodeTitle;
      readonly revision: number;
    }
  /**
   * The viewer marked a movie, one version of a film, watched or unwatched by hand. Like an
   * episode's mark it names no length and leaves how far the file played as it is, under the
   * mark: a play of the movie begun later replaces it. Builds from before it skip it.
   */
  | { readonly type: "movie-marked"; readonly title: MovieTitle; readonly watched: boolean }
  /** The movie's mark the event numbered `revision` made was taken back: it stands as before. */
  | { readonly type: "movie-mark-undone"; readonly title: MovieTitle; readonly revision: number }
  /**
   * The version a marked series was last marked in lists other episodes than it did then, or its
   * subscription other versions of it: where the series goes on is worked out from these from
   * now on. Its marks are as they were.
   */
  | {
      readonly type: "series-listed";
      readonly series: string;
      readonly versions: readonly string[];
      readonly listing: SeriesListing;
    };

/** An episode by the provider's own ids. */
export type EpisodeTitle = Extract<RawTitleRef, { readonly kind: "episode" }>;

/** A movie by the provider's own id. */
export type MovieTitle = Extract<RawTitleRef, { readonly kind: "movie" }>;

/**
 * The episodes a series version lists, by their numbers: its seasons in the provider's order,
 * specials (season 0) wherever they stand, each with its episodes' numbers in order.
 */
export type SeriesListing = readonly {
  readonly number: number;
  readonly episodes: readonly number[];
  /** Exact current M3U source files. Missing on legacy and Xtream listings. */
  readonly files?: readonly string[];
}[];

export type ChannelEvent = Extract<ViewingEvent, { readonly channelId: string }>;

/** An episode's mark, several at once, one taken back, or what a marked series lists. */
export type MarkEvent = Extract<ViewingEvent, { readonly series: string }>;

/** A movie's mark, or one taken back: kept by the movie, beside how far it got. */
export type FilmMarkEvent = Extract<ViewingEvent, { readonly type: `movie-${string}` }>;

export type TitleEvent = Exclude<ViewingEvent, ChannelEvent | MarkEvent>;

/** A movie's mark as an account's record keeps it. */
export type StoredFilmMark = {
  readonly title: MovieTitle;
  readonly watched: boolean;
  /** When it was marked: epoch milliseconds. A play of the movie begun later replaces it. */
  readonly at: number;
  /** Names this mark for Undo: the number of the event that made it. */
  readonly revision: number;
  /**
   * The movie's mark before it, or null when it had none, while this one can still be taken back:
   * until the movie is marked again, played or taken out of Continue watching. Null when it can't.
   */
  readonly undo: { readonly prior: Omit<StoredFilmMark, "undo"> | null } | null;
};

/** An episode's mark as an account's record keeps it: with the episode it was made on. */
export type StoredMark = EpisodeMark & {
  /** What the series is kept under: see `SeriesIdentity.key`. */
  readonly series: string;
  /** The episode in the series version it was marked in. */
  readonly title: EpisodeTitle;
};

export type ViewingCommand =
  | {
      readonly kind: "set-favourite";
      /**
       * The channel's own id and its streams': any of them among the favourites makes it one.
       * Adding keeps them all, so the channel stays a favourite while any of its streams is listed.
       */
      readonly channelIds: readonly string[];
      readonly favourite: boolean;
    }
  | { readonly kind: "record-watch"; readonly channelId: string }
  | {
      readonly kind: "record-progress";
      readonly title: RawTitleRef;
      readonly position: number;
      readonly duration: number;
      readonly since: number;
    }
  /** Movies, and episodes standing for their series, out of Continue watching at once. */
  | { readonly kind: "remove-titles"; readonly titles: readonly RawTitleRef[] }
  /** An episode standing for each version of a series played, whose last episode was watched. */
  | { readonly kind: "finish-series"; readonly titles: readonly RawTitleRef[] };

/**
 * One account's favourites and recently watched channels, by the provider's stream ids: one or
 * more per channel. The service shows them by channel (see ./service.ts).
 */
export type ViewingState = {
  /** In the order they were added, or the order the viewer gave them since. */
  readonly favourites: readonly string[];
  /** Most recent first, at most `RECENT_LIMIT`. */
  readonly recent: readonly string[];
};

export const emptyState: ViewingState = { favourites: [], recent: [] };

/** A channel in one account's record, by the provider's stream id. */
export type StoredChannel = {
  /** The account whose record holds it. */
  readonly account: string;
  readonly id: string;
};

/** An event, and the account whose record it joins. */
export interface AccountEvent {
  readonly account: string;
  readonly event: ViewingEvent;
}

/** The events a command produces from `state`. Asking for what already holds produces none. */
export function decide(state: ViewingState, command: ViewingCommand): ViewingEvent[] {
  switch (command.kind) {
    case "set-favourite": {
      const listed = state.favourites.filter((id) => command.channelIds.includes(id));

      if (!command.favourite) {
        return listed.map((channelId) => ({ type: "favourite-removed", channelId }));
      }

      if (listed.length > 0) return [];

      return command.channelIds.map((channelId) => ({ type: "favourite-added", channelId }));
    }

    case "record-watch":
      return [{ type: "watched", channelId: command.channelId }];
    case "record-progress":
      return [
        {
          type: "title-progress",
          title: command.title,
          position: command.position,
          duration: command.duration,
          since: command.since,
        },
      ];
    case "remove-titles":
      return command.titles.map((title) => ({ type: "title-removed", title }));
    case "finish-series":
      return command.titles.map((title) => ({ type: "series-finished", title }));
  }
}

/**
 * The events that put the favourites `current`, of one account or several read as one, in the
 * order `wanted`: the same favourites, each once, and no other. A favourite moves only by leaving
 * and coming back, and comes back last, after every favourite of every account. So the start of
 * the new order that the stored one already holds, in that order, stays where it is, and the rest
 * leaves and comes back in the order wanted, each in its own account's record. An order that
 * changes nothing makes none.
 */
export function reordered(
  current: readonly StoredChannel[],
  wanted: readonly StoredChannel[],
): AccountEvent[] {
  let kept = 0;

  for (const { account, id } of current) {
    const next = wanted[kept];

    if (next?.account === account && next.id === id) kept++;
  }

  const moved = wanted.slice(kept);

  const as = (type: "favourite-removed" | "favourite-added") =>
    moved.map(({ account, id }): AccountEvent => ({ account, event: { type, channelId: id } }));

  return [...as("favourite-removed"), ...as("favourite-added")];
}

/** Whether an event is about how far a movie or episode got, or its place in Continue watching. */
export function isTitleEvent(event: ViewingEvent): event is TitleEvent {
  return "title" in event && !isMarkEvent(event);
}

/** The events a bulk mark receipt needs to recover its original count and Undo. */
export function isMarkReceiptEvent(
  event: ViewingEvent,
): event is Extract<ViewingEvent, { readonly type: "movie-marked" | "episodes-marked" }> {
  return event.type === "movie-marked" || event.type === "episodes-marked";
}

/** Whether an event is a movie's mark or one taken back. */
export function isFilmMarkEvent(event: ViewingEvent): event is FilmMarkEvent {
  return event.type === "movie-marked" || event.type === "movie-mark-undone";
}

/** Whether an event is an episode's mark, one taken back, or what a marked series lists. */
export function isMarkEvent(event: ViewingEvent): event is MarkEvent {
  return "series" in event;
}

/**
 * The state after channel events, in their order. Title events change title rows instead; see
 * ./titles.ts. It takes the favourites and the events once each, however many there are: a new
 * order of a long list removes and adds most of it.
 */
export function apply(state: ViewingState, events: readonly ChannelEvent[]): ViewingState {
  // A set keeps its ids in the order added, and adding one it holds changes nothing.
  const favourites = new Set(state.favourites);
  let recent = state.recent;

  for (const event of events) {
    switch (event.type) {
      case "favourite-added":
        favourites.add(event.channelId);
        break;
      case "favourite-removed":
        favourites.delete(event.channelId);
        break;
      case "watched":
        recent = [event.channelId, ...recent.filter((id) => id !== event.channelId)].slice(
          0,
          RECENT_LIMIT,
        );
    }
  }

  return { favourites: [...favourites], recent };
}

/**
 * The events that bring lists from before the record into it: favourites in their order, then
 * recent channels oldest first, so the most recent ends up first.
 */
export function importEvents(lists: {
  readonly favourites: readonly string[];
  readonly recent: readonly string[];
}): ViewingEvent[] {
  return [
    ...lists.favourites.map((channelId): ViewingEvent => ({ type: "favourite-added", channelId })),
    ...lists.recent.toReversed().map((channelId): ViewingEvent => ({ type: "watched", channelId })),
  ];
}
