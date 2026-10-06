// What the viewer keeps per account: favourite channels, the channels watched recently, and how
// far movies and episodes got. The main process records them as events (see
// @mrstreamer/core/viewing); the UI reads this state.
import type { TitleRef } from "./ondemand.ts";

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
  /** Channel ids in the order they were added, or the order the viewer gave them since. */
  readonly favourites: readonly string[];
  /** Channel ids, most recently watched first, at most `RECENT_LIMIT`. */
  readonly recent: readonly string[];
  /**
   * Movies started and not finished, and for each series the episode watched last, finished or
   * not, most recent first, at most `CONTINUE_OFFERED`. Removed ones stay out until played again.
   */
  readonly continueWatching: readonly TitleProgress[];
  /** How far the record has come for this account: a later change has a higher number. */
  readonly sequence: number;
}

/**
 * A new order for a subscription's favourites, from the list it was arranged in. The record
 * takes it only while that list still holds, so an order made from an older one never lands on
 * favourites changed since, nor on another subscription's.
 */
export interface FavouriteOrder {
  /** The subscription the favourites were read from, by `SubscriptionSummary.id`. */
  readonly subscription: string;
  /** Its favourites as `Viewing.favourites` gave them: every one, in order. */
  readonly original: readonly string[];
  /**
   * Those of them the viewer arranged, in the order wanted. The rest, channels the lists don't
   * show or the provider no longer lists, keep their places.
   */
  readonly order: readonly string[];
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
