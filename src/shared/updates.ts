// In-app updates and release channels, as the UI sees them.
import type { Channel } from "./version.ts";

/** Where the in-app update stands. Nothing downloads or restarts until the user asks. */
export type UpdatePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  /** Nothing newer on the chosen channel. */
  | { readonly kind: "current" }
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number }
  /** Downloaded and checked; installs when the user confirms the restart. */
  | { readonly kind: "ready"; readonly version: string }
  | {
      readonly kind: "failed";
      readonly step: "check" | "download" | "install";
      readonly detail: string;
    };

export interface UpdateStatus {
  /** The installed version. */
  readonly version: string;
  readonly channel: Channel;
  readonly update: UpdatePhase;
}
