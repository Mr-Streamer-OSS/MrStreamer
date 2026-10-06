// The watchlist: movies and whole series the viewer saved to watch later, never an episode. It is
// kept apart from how far anything got: playing, finishing or leaving Continue watching changes
// nothing here, and only removing an entry takes it out.
//
// The main process keeps what each account saved, and the UI reads pages of entries made of all
// saved subscriptions' together. A film two of them list under one TMDB id is one title in the
// lists, and one entry here, whichever of them saved it.
import type { Title, TitleKind } from "./ondemand.ts";

/** How the Watchlist is ordered: the title saved last first, or by name. */
export const WATCHLIST_SORTS = ["saved", "title"] as const;
export type WatchlistSort = (typeof WATCHLIST_SORTS)[number];

/**
 * A saved movie or series. `subscriptionId` and `id` name it, as an `OwnedId`, by what was saved
 * of it first: that is what removing it sends, and it stays the same whichever version the lists
 * show first and whatever language the viewer picks.
 */
export interface WatchlistEntry {
  readonly subscriptionId: string;
  readonly id: string;
  readonly kind: TitleKind;
  /** Its name and year as the lists last had them, for when they have it no more. */
  readonly name: string;
  readonly year: number | null;
  /** When it was saved: epoch milliseconds. Saving it again leaves this as it was. */
  readonly savedAt: number;
  /**
   * The title as the lists have it now, with the versions of every subscription that lists it.
   * Null when none does, or the lists weren't there to look in.
   */
  readonly title: Title | null;
  /** A picture for an entry without a title, from TMDB when it knows the title. */
  readonly artworkUrl: string | null;
  /**
   * The subscriptions that hold it saved, in their order: those it was saved from. One added
   * since that lists the title too plays it, and isn't among them.
   */
  readonly sources: readonly string[];
  /**
   * Whether the lists of every one of `sources` were there to look in. Without them an entry
   * that has no title says nothing about whether its provider still lists it.
   */
  readonly listed: boolean;
}

/** One page of the watchlist. */
export interface WatchlistPage {
  /** How many are saved, without those for adults while the viewer hides them. */
  readonly total: number;
  readonly entries: readonly WatchlistEntry[];
}
