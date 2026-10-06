// Where playback goes: this computer, or a receiver on the local network that plays what the app
// sends it. The main process owns the receiver and what it plays; the UI shows the status it is
// sent and asks for changes. A receiver plays from an address this computer serves on the local
// network, so it never sees a provider address.
import type { TitleRef } from "./ondemand.ts";
import type { AudioTrack, StreamFailure, SubtitleFormat, SubtitleTrack } from "./playback.ts";
import type { OwnedId } from "./subscription.ts";

/** The ways the app sends playback to a receiver. */
export const RECEIVER_KINDS = ["cast", "airplay"] as const;
export type ReceiverKind = (typeof RECEIVER_KINDS)[number];

export interface Receiver {
  /** Names it for `output.connect` while it is listed. */
  readonly id: string;
  readonly kind: ReceiverKind;
  /** "Living Room TV", as it names itself; null when the system doesn't say, as for AirPlay. */
  readonly name: string | null;
}

/** Why a receiver doesn't play. */
export type OutputFailure =
  /** It didn't answer, or the connection to it broke. */
  | { readonly kind: "unreachable" }
  /** It never asked this computer for the media: a firewall here, or it is on another network. */
  | { readonly kind: "not-fetched" }
  /** It took the media and couldn't play it. */
  | { readonly kind: "media"; readonly detail: string }
  /** This computer has no address on a local network. */
  | { readonly kind: "no-network" }
  /** The part of the app that speaks to the receiver is missing or stopped. */
  | { readonly kind: "unavailable"; readonly detail: string }
  /** The provider didn't deliver the stream. */
  | { readonly kind: "stream"; readonly failure: StreamFailure };

/** What a receiver plays, and from which subscription. */
export type RemoteItem =
  | { readonly kind: "channel"; readonly channel: OwnedId }
  | { readonly kind: "title"; readonly title: TitleRef };

/**
 * `loading` from when the media was sent until the receiver says its player is past starting:
 * playing or held paused over Cast, ready to play over AirPlay, where it may be `buffering` before
 * anything plays. That is the receiver's word for how its player stands, not proof that a picture
 * shows. `ended` only when it played to the end.
 */
export type RemoteState = "loading" | "buffering" | "playing" | "paused" | "ended";

/** What the receiver plays now, as it last confirmed. */
export interface RemoteMedia {
  /**
   * Counts what was sent to receivers. Commands name it, and one for an earlier load is dropped,
   * as is anything a receiver says about one.
   */
  readonly generation: number;
  readonly sessionId: string;
  readonly item: RemoteItem;
  readonly state: RemoteState;
  /** Seconds into the title when the receiver last said, and when that was, in epoch ms. */
  readonly position: number;
  readonly at: number;
  /** Seconds; null for a channel. */
  readonly duration: number | null;
  /** Whether the stream's text subtitles show. */
  readonly subtitles: boolean;
}

export type Output =
  | { readonly kind: "local" }
  /**
   * Reaching a receiver, or waiting for the viewer in the system's own list, where the receiver
   * isn't known yet. Playback here goes on meanwhile.
   */
  | {
      readonly kind: "connecting";
      readonly protocol: ReceiverKind;
      readonly receiver: Receiver | null;
    }
  | {
      readonly kind: "receiver";
      readonly receiver: Receiver;
      /** Its volume, 0 to 1, or null when it can't be set from here. */
      readonly volume: { readonly level: number; readonly muted: boolean } | null;
      readonly media: RemoteMedia | null;
      /** Why what was sent last doesn't play, with the receiver still there. */
      readonly failure: OutputFailure | null;
    }
  /** The receiver is gone. Nothing plays until the viewer tries again or plays here. */
  | { readonly kind: "lost"; readonly receiver: Receiver; readonly failure: OutputFailure };

export interface OutputStatus {
  /** What this build sends to; empty where it can't reach any receiver. */
  readonly offers: readonly ReceiverKind[];
  /** Whether the system sees an AirPlay receiver; null where AirPlay isn't offered. */
  readonly airplayRoutes: boolean | null;
  /** Looking for receivers now. */
  readonly scanning: boolean;
  /** The receivers found that the app lists itself. AirPlay's are the system's to list. */
  readonly receivers: readonly Receiver[];
  readonly output: Output;
}

/** A movie or episode opened for a receiver: what its file holds, before anything is sent. */
export interface RemoteTitle {
  readonly sessionId: string;
  readonly title: TitleRef;
  /** Seconds. */
  readonly duration: number;
  /** Sound tracks in the file's order. */
  readonly audio: readonly AudioTrack[];
  /** Subtitle tracks in the file's order, whatever their format. */
  readonly subtitles: readonly SubtitleTrack[];
  /** The kinds of subtitles a receiver shows. The others only this computer's player draws. */
  readonly shows: readonly SubtitleFormat[];
}

/** The title a receiver plays: what its file holds, and the tracks it plays with. */
export interface RemotePlayingTitle {
  readonly title: RemoteTitle;
  readonly audio: number | null;
  readonly subtitle: number | null;
}

/** What a receiver can be told about what it plays. */
export type RemoteCommand =
  | { readonly command: "play" | "pause" | "stop" }
  /** Moves to `position` seconds into the title. */
  | { readonly command: "seek"; readonly position: number }
  /** Shows or hides the stream's text subtitles. */
  | { readonly command: "subtitles"; readonly on: boolean };
