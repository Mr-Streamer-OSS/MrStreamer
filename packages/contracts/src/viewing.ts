// What the viewer keeps per account: favourite channels, the channels watched recently, and how
// far movies and episodes got. The main process records them as events (see
// @mrstreamer/core/viewing); the UI reads this state, in which everything names its subscription.
// It holds every saved subscription's at once: the favourites in the order starred, whichever
// subscription each is from, and the rest by when it was watched.
import type { TitleRef } from "./ondemand.ts";
import type { OwnedId } from "./subscription.ts";

/** How many channels the recently watched list shows. */
export const RECENT_LIMIT = 12;

/** How many movies and series Continue watching shows. */
export const CONTINUE_LIMIT = 20;

/**
 * How many the record offers it: more than it shows, so the titles the UI leaves out, those for
 * adults and those the provider no longer lists, don't push the others off the row.
 */
export const CONTINUE_OFFERED = 100;

export interface Viewing {
  /** Channels in the order they were added, or the order the viewer gave them since. */
  readonly favourites: readonly OwnedId[];
  /** Channels, most recently watched first, at most `RECENT_LIMIT`. */
  readonly recent: readonly OwnedId[];
  /**
   * Movies started and not finished, and for each series the episode watched last, finished or
   * not, most recent first, at most `CONTINUE_OFFERED`. Removed ones stay out until played again.
   */
  readonly continueWatching: readonly TitleProgress[];
  /** How far the record has come: a later change has a higher number. */
  readonly sequence: number;
}

/**
 * A new order for the favourites, from the list it was arranged in. The record takes it only
 * while that list still holds, so an order made from an older one never lands on favourites
 * changed since, nor on those of a subscription that went or took another's place: each favourite
 * names its subscription, so the lists then differ.
 */
export interface FavouriteOrder {
  /** The favourites as `Viewing.favourites` gave them: every one, of every subscription, in order. */
  readonly original: readonly OwnedId[];
  /**
   * Those of them the viewer arranged, in the order wanted. The rest, channels the lists don't
   * show or the provider no longer lists, keep their places.
   */
  readonly order: readonly OwnedId[];
}

/**
 * Which titles' progress to read or change: movies, and every episode of the series, by the ids
 * of their versions. Each language version of a film or series has its own.
 */
export interface TitleFilter {
  readonly movies?: readonly OwnedId[];
  readonly series?: readonly OwnedId[];
}

/** How far a movie or an episode got. */
export interface TitleProgress {
  readonly title: TitleRef;
  /** Seconds from the start. */
  readonly position: number;
  /** Seconds, as the player knew it. */
  readonly duration: number;
  /** Watched to the credits. */
  readonly finished: boolean;
  /** When it was last played: epoch milliseconds. */
  readonly at: number;
}
