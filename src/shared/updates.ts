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
  | { readonly kind: "failed"; readonly step: "check" | "download"; readonly detail: string };

/** Going back to Stable with this device's data erased. */
export type FreshStart =
  | { readonly kind: "idle" }
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number }
  /** Stable is downloaded and checked; erasing waits for the final confirmation. */
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "failed"; readonly detail: string }
  /** A confirmed start erased this device's data, but Stable did not install. */
  | { readonly kind: "not-installed"; readonly version: string };

export interface UpdateStatus {
  /** The installed version. */
  readonly version: string;
  readonly channel: Channel;
  /**
   * On Stable, when the installed nightly is newer than the newest stable release: that
   * release. Updates resume once Stable passes the installed version.
   */
  readonly aheadOf: string | null;
  readonly update: UpdatePhase;
  readonly fresh: FreshStart;
}
