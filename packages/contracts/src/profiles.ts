// Viewing profiles as the window sees them. Default keeps earlier releases' personal state in
// place; named profiles keep their own viewing records, lists and preferences. Kids profiles
// additionally require explicit approved-content identities.
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
 * installation's Analytics consent and safe stop/Quit controls belong to no single viewer.
 */
export function ownedByProfile(method: string): boolean {
  return (
    !method.startsWith("profiles.") &&
    !method.startsWith("analytics.") &&
    method !== "downloads.pause" &&
    method !== "recordings.stop" &&
    method !== "window.quit"
  );
}

/** A local viewing profile, including deletion that can be retried after a storage refusal. */
export interface LocalProfile {
  readonly id: string;
  readonly name: string;
  readonly deleting: boolean;
  readonly kids?: boolean;
}

/** An approval never transfers between providers or between online and household copies. */
export const KidsApprovalSchema = lazy(() =>
  type(
    {
      kind: "'channel' | 'movie' | 'series'",
      subscriptionId: "string > 0",
      id: "string > 0",
    },
    "|",
    { kind: "'download' | 'recording'", id: "string > 0" },
  ),
);

export type KidsApproval = ReturnType<typeof KidsApprovalSchema>["infer"];

export const KidsProfilePolicySchema = lazy(() =>
  type({ id: "string > 0", approved: KidsApprovalSchema().array() }),
);

export type KidsProfilePolicy = ReturnType<typeof KidsProfilePolicySchema>["infer"];

export interface KidsPolicy {
  readonly protected: boolean;
  readonly profiles: readonly KidsProfilePolicy[];
}
