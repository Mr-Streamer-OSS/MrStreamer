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
