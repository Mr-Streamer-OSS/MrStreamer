// What the viewer keeps per account: favourite channels and the channels watched recently. The
// main process records them as events (see @mrstreamer/core/viewing); the UI reads this state.

/** How many channels the recently watched list shows. */
export const RECENT_LIMIT = 12;

export interface Viewing {
  /** Channel ids in the order they were added. */
  readonly favourites: readonly string[];
  /** Channel ids, most recently watched first, at most `RECENT_LIMIT`. */
  readonly recent: readonly string[];
  /** How far the record has come for this account: a later change has a higher number. */
  readonly sequence: number;
}
