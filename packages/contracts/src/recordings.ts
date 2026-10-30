// Recordings as the window sees them: local copies Mr. Streamer captured from a live channel
// while it ran. The main process keeps each one's record and file; paths, addresses and logins
// stay there. Times are epoch milliseconds, as the guide's.
import type { OwnedId } from "./subscription.ts";

/** Why a recording ended before its stop time. */
export type RecordingCut =
  /** The app quit, or closed while it recorded. */
  | "quit"
  /** The provider stopped sending, or the connection broke. */
  | "stream"
  /** Its file couldn't be written, as on a full disk. */
  | "disk";

/** Where a recording stands. */
export type RecordingStatus =
  /** Capturing now, until its stop time. */
  | { readonly kind: "recording" }
  /** Captured from when it started to its stop time. */
  | { readonly kind: "complete" }
  /** The viewer stopped it before its stop time; what was captured stays. */
  | { readonly kind: "stopped" }
  /** It ended early for `cut`; what was captured stays and plays. */
  | { readonly kind: "partial"; readonly cut: RecordingCut }
  /** Its file is no longer in the app's folder. */
  | { readonly kind: "missing" };

export interface Recording {
  /** Names it for `recordings.stop`, `recordings.remove` and `playback.openCopy`. */
  readonly id: string;
  readonly channel: OwnedId;
  readonly channelName: string;
  /** The programme on air as it started, as the guide listed it, else the channel's name. */
  readonly title: string;
  /** When capture was asked to start. */
  readonly start: number;
  /** When it was set to stop. */
  readonly stop: number;
  /** When it actually ended; null while it records. */
  readonly ended: number | null;
  /** Bytes in its file. */
  readonly bytes: number;
  readonly status: RecordingStatus;
}

/** What holds one of a subscription's connections in this app now. */
export type ConnectionUse = "watch" | "download" | "recording";

/**
 * A subscription's provider connections as a recording would see them: how many the account
 * allows, as its provider last said (one when it never said), and what of this app holds them now.
 * Other devices on the same account aren't seen.
 */
export interface RecordingConnections {
  readonly limit: number;
  readonly uses: readonly ConnectionUse[];
}

/** What asking to record answered: started, or every connection is held by what `connections` lists. */
export type RecordingStart =
  | { readonly kind: "started"; readonly recording: Recording }
  | { readonly kind: "busy"; readonly connections: RecordingConnections };

/** The longest a recording may be set to run, from when it starts. */
export const RECORDING_MAX_MS = 12 * 60 * 60 * 1000;
