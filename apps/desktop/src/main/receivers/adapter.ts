// What the output service asks of a way to reach receivers: Google Cast (./cast) and AirPlay
// (./airplay). An adapter finds receivers, connects to one and passes on what the service wants
// played; it never opens a provider stream and knows no provider address. The media it is given
// is an address the playback service serves on the local network for one load.
//
// Everything about a load carries its generation, which the service counts. An adapter drops
// what it still has to do for an earlier one, and reports what the receiver says with the
// generation the receiver's media belongs to, so the service can tell a late answer from news.
import type { OutputFailure, Receiver, ReceiverKind } from "@mrstreamer/contracts/output";
import type { Codec } from "@mrstreamer/contracts/playback";

/** One load: an HLS playlist for the receiver to play, and how to start it. */
export interface ReceiverMedia {
  readonly generation: number;
  /** http://<this computer on the LAN>:<port>/r/<token>/master.m3u8. Carries no login. */
  readonly url: string;
  /** A channel: no length, no seeking. */
  readonly live: boolean;
  /** Seconds into the title to start at; 0 for a channel. */
  readonly position: number;
  /** Start held on the first picture. */
  readonly paused: boolean;
  /** Seconds; null for a channel, or when the file doesn't say. */
  readonly duration: number | null;
  /** Show the playlist's text subtitles from the start. It carries one rendition at most. */
  readonly subtitles: boolean;
  /** What the receiver may show about it. */
  readonly metadata: {
    readonly title: string;
    readonly subtitle: string | null;
    /** An https picture anyone may fetch, or null. */
    readonly artworkUrl: string | null;
  };
}

/**
 * `ended` only when the receiver played the media to its end. `stopped` when it holds no media
 * of this load any more for another reason: stopped from here, replaced, or cancelled there.
 */
export type TransportState = "loading" | "buffering" | "playing" | "paused" | "ended" | "stopped";

/** What the receiver last said of a load. */
export interface TransportStatus {
  readonly generation: number;
  readonly state: TransportState;
  /** Seconds into the media, and when the receiver said so, as `Date.now()`. */
  readonly position: number;
  readonly at: number;
  /** Seconds, as the receiver reads the media; null for a channel or before it knows. */
  readonly duration: number | null;
}

export type AdapterEvent =
  /** The receivers found so far, while scanning. Adapters whose receivers the system lists send none. */
  | { readonly type: "receivers"; readonly receivers: readonly Receiver[] }
  /** Whether the system sees any receiver, for an adapter that can't list them. */
  | { readonly type: "routes"; readonly available: boolean }
  | { readonly type: "status"; readonly status: TransportStatus }
  /** The receiver's volume, 0 to 1. */
  | { readonly type: "volume"; readonly level: number; readonly muted: boolean }
  /** The receiver couldn't play a load; it is still connected. */
  | { readonly type: "media-failed"; readonly generation: number; readonly failure: OutputFailure }
  /**
   * The connected receiver let go without a failure: someone stopped the app on it, or the viewer
   * picked this computer in the system's list.
   */
  | { readonly type: "released" }
  /** The connection to the receiver broke, after the adapter's own bounded tries to get it back. */
  | { readonly type: "lost"; readonly failure: OutputFailure };

/** A place on screen, in the screen's own points, for a system picker to open from. */
export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type ConnectRequest =
  /** A receiver the adapter listed, by its id. */
  | { readonly kind: "receiver"; readonly id: string }
  /** The system's own list of receivers, opened at `anchor`. */
  | { readonly kind: "picker"; readonly anchor: ScreenRect };

/** A connect, load or command the receiver didn't take; `failure` says why. */
export class ReceiverFailed extends Error {
  readonly failure: OutputFailure;
  constructor(failure: OutputFailure) {
    super(failure.kind);
    this.failure = failure;
  }
}

export interface ReceiverAdapter {
  readonly kind: ReceiverKind;
  /** Hears everything the adapter reports. The output service is the one listener. */
  listen(listener: (event: AdapterEvent) => void): void;
  /** Looks for receivers while `on`. Connects to none and opens no stream. */
  scan(on: boolean): void;
  /**
   * Connects to a receiver, ready to take media. Null when the viewer closed the system's list
   * without picking one: nothing changed then. Rejects with `ReceiverFailed`, also when `signal`
   * aborts first, and leaves nothing connected.
   */
  connect(request: ConnectRequest, signal: AbortSignal): Promise<Connection | null>;
  /**
   * Lets go of everything, the receiver included: for quitting. Resolves within a second or two
   * whatever the receiver does.
   */
  close(): Promise<void>;
}

/**
 * A receiver ready to play. Commands resolve once the receiver took them and reject with
 * `ReceiverFailed`; one for a generation that is no longer the receiver's resolves and does
 * nothing. The receiver's own news comes through the adapter's listener.
 */
export interface Connection {
  readonly receiver: Receiver;
  /** This computer's address as the receiver reaches it, when the adapter knows; else null. */
  readonly localAddress: string | null;
  /** What the receiver decodes: these tracks are copied, the rest convert. */
  readonly decoders: readonly Codec[];
  /** Whether its volume can be set from here. */
  readonly volume: boolean;
  /**
   * Has the receiver play `media` in place of what it had. Resolves once it took the load, which
   * is before the picture; rejects when it refuses, and when `signal` aborts.
   */
  load(media: ReceiverMedia, signal: AbortSignal): Promise<void>;
  play(generation: number): Promise<void>;
  pause(generation: number): Promise<void>;
  /** Moves to `position` seconds into the title. */
  seek(generation: number, position: number): Promise<void>;
  /** Shows or hides the load's text subtitles. */
  showSubtitles(generation: number, on: boolean): Promise<void>;
  setVolume(volume: { readonly level?: number; readonly muted?: boolean }): Promise<void>;
  /** Ends the load and keeps the receiver. */
  stop(generation: number): Promise<void>;
  /** Ends what plays and lets go of the receiver. Resolves within a second or two regardless. */
  disconnect(): Promise<void>;
}
