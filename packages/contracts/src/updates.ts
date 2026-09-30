// In-app updates and release channels, as the UI sees them.
import type { Channel } from "./version.ts";

/** Why a check found nothing, in terms the UI explains. */
export type CheckFailure =
  /** No connection, or the server didn't answer. */
  | { readonly kind: "offline" }
  /** GitHub is limiting requests from this network; `until` is when it allows them again. */
  | { readonly kind: "busy"; readonly until: number | null }
  /** The update server answered with an HTTP error. */
  | { readonly kind: "http"; readonly status: number }
  /** The answer wasn't an update list. */
  | { readonly kind: "invalid" };

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
  /** A check the user asked for failed. Automatic checks fail quietly into `checked`. */
  | { readonly kind: "failed"; readonly step: "check"; readonly failure: CheckFailure }
  | {
      readonly kind: "failed";
      readonly step: "download" | "install";
      readonly version: string;
      readonly detail: string;
    };

/** The release a check found for the chosen channel. */
export interface UpdateOffer {
  readonly version: string;
  /** The release notes, in Markdown, when the source has them. */
  readonly notes: string | null;
  /** The release's page, for reading more and downloading it by hand. */
  readonly page: string | null;
}

export interface UpdateStatus {
  /** The installed version. */
  readonly version: string;
  readonly channel: Channel;
  readonly update: UpdatePhase;
  /** What the last successful check offered; kept while later checks fail. */
  readonly offer: UpdateOffer | null;
  /** The last check, automatic or asked for, and why it failed if it did. */
  readonly checked: { readonly at: number; readonly failure: CheckFailure | null } | null;
  /** When the next automatic check runs, or null while none is planned. */
  readonly nextCheckAt: number | null;
  /** The version whose notice the viewer closed. Settings still offers it; a newer one notifies. */
  readonly dismissed: string | null;
}
