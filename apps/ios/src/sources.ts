import type { Provider } from "@mrstreamer/core/provider";
import { signIns } from "@mrstreamer/mobile/accounts/sign-ins";

// What signs in to each saved subscription: its provider adapter, which holds the login, and the
// login's parts, which stream addresses carry and failures must not show. Kept here, apart from
// every store, so no screen, snapshot or failure holds a password. Only account.ts sets and drops
// them; titles.ts, play-title.ts and live playback ask for the one a request names, and
// artwork-cache.ts checks picture addresses against all of them. The Android app keeps its logins
// the same way (@mrstreamer/mobile/accounts/sign-ins).

export interface Source {
  /** Rises with every new login of any subscription: an answer for an older one is dropped. */
  readonly revision: number;
  readonly provider: Provider;
  /** `[username, ...passwords]`: a playlist's are the user and secrets its link names. */
  readonly login: readonly string[];
  /**
   * A playlist link's query values that may be a token or a setting (`playlistUncertain`): saved
   * copies hold none whole (core's `whole`), as a text, address part or part of either.
   */
  readonly uncertain?: readonly string[];
}

const logins = signIns<Source>();

/** The signed-in source of `subscriptionId`, or a typed failure when it has none. */
export const sourceOf = logins.of;

/** The source, if signed in: for checks that a load still answers the login it was made for. */
export const currentSource = logins.current;

/** Recognized login parts. Playback also redacts its captured Source's uncertain values. */
export const loginOf = (subscriptionId: string): readonly string[] =>
  logins.current(subscriptionId)?.login ?? [];

/**
 * Every signed-in source, for artwork-cache.ts to tell whether an address carries a login, and
 * whether the login it carried is still current.
 */
export const signedIn = logins.all;

/**
 * How many logins were replaced or dropped in this process: while none was, every login that gave
 * the lists shown is still signed in.
 */
export const retiredLogins = logins.replaced;

/** Calls `listener` after each login set or dropped; answers how to stop. */
export const onSignedIn = logins.onChange;

/** Signs a subscription in with `source`: loads begun under its login before no longer stand. */
export const setSource = logins.set;

/** Signs a subscription out, ending its loads. */
export const dropSource = logins.drop;

/**
 * Begins loading one of a subscription's lists under its login, ending the load of it before.
 * Only account.ts loads lists.
 */
export const beginLoad = logins.begin;
