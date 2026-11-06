import { type } from "arktype";
import { lazy } from "./lazy.ts";
// Viewing profiles as the window sees them. A viewing profile is one person's viewing space on a
// shared installation (GLOSSARY.md). This release has one, Default, which owns the personal state
// every earlier release kept: favourites, recent channels, progress, the Watchlist, channel lists
// and viewing preferences. Another profile is offered only once all of that is kept apart per
// profile.

/** The id of the Default profile. */
export const DEFAULT_PROFILE_ID = "default";

/** The profile whose viewing the app shows now. */
export interface ActiveProfile {
  /** Opaque: compare it, never parse it. */
  readonly id: string;
  /**
   * Grows each time another profile becomes active, and never goes back, so a reply begun for an
   * earlier profile can be told apart.
   */
  readonly revision: number;
}

/** Validated owner of an admitted desktop request or playback session. */
export const ActiveProfileSchema = lazy(() =>
  type({ id: "string > 0", revision: "number.integer >= 1" }),
);

/** Desktop transport metadata. Domain method schemas still validate only `input`. */
export interface ProfileRequest<Input> {
  readonly __profile: ActiveProfile | undefined;
  readonly input: Input | undefined;
}

/** A local viewing profile, including deletion that can be retried after a storage refusal. */
export interface LocalProfile {
  readonly id: string;
  readonly name: string;
  readonly deleting: boolean;
}
