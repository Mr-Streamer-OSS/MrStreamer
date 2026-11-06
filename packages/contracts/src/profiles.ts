// Viewing profiles as the window sees them. A viewing profile is one person's viewing space on a
// shared installation (GLOSSARY.md). This release has one, Default, which owns the personal state
// every earlier release kept: favourites, recent channels, progress, the Watchlist, channel lists
// and viewing preferences. Another profile is offered only once all of that is kept apart per
// profile.
import { type } from "arktype";
import { lazy } from "./lazy.ts";

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

/** The same visit of the same profile: switching away and back is another revision. */
export function sameProfile(a: ActiveProfile, b: ActiveProfile): boolean {
  return a.id === b.id && a.revision === b.revision;
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

/**
 * Whether a desktop request runs as its sender's profile. Profile lifecycle and the
 * installation's Analytics consent belong to no single viewer.
 */
export function ownedByProfile(method: string): boolean {
  return !method.startsWith("profiles.") && !method.startsWith("analytics.");
}

/** A local viewing profile, including deletion that can be retried after a storage refusal. */
export interface LocalProfile {
  readonly id: string;
  readonly name: string;
  readonly deleting: boolean;
}
