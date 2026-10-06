// The programme guide as the UI sees it. Times are epoch milliseconds.
import type { LiveChannel } from "./library.ts";

export interface Programme {
  readonly start: number;
  readonly stop: number;
  readonly title: string;
  readonly description: string | null;
}

/** What a channel shows now and next. Either is null where the guide has a gap or ends. */
export interface Listing {
  readonly now: Programme | null;
  readonly next: Programme | null;
}

/** A programme that matched a search, on the channel that shows it. */
export interface ProgrammeMatch {
  readonly channel: LiveChannel;
  readonly programme: Programme;
}

/**
 * What a search within a list of channels found in one channel's programmes today. Without
 * descriptions: the channel's schedule has them.
 */
export interface ListingMatch {
  /** Whether the programme on now matches. */
  readonly now: boolean;
  /** The first later one that matches, or null. */
  readonly later: Pick<Programme, "start" | "title"> | null;
}

/**
 * Whether the subscription has a programme guide. `unknown`: it hasn't answered yet, as before
 * the first download or when asking failed. `available`: a guide of it is loaded. `none`: it
 * answered that it has none, as a playlist does whose first line names no guide.
 */
export type GuideAvailability = "unknown" | "available" | "none";

/** A subscription's guide as Settings shows it: how many channels it covers, and since when. */
export interface GuideStatus {
  /** The subscription whose guide this is. */
  readonly subscriptionId: string;
  /** Channels of its catalogue with programmes in the guide. */
  readonly channels: number;
  /** Epoch milliseconds of the download, or null before one, or without a guide. */
  readonly fetchedAt: number | null;
  /** Where the guide comes from stays in the main process: this says only whether there is one. */
  readonly availability: GuideAvailability;
}
