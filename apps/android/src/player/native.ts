import { requireNativeModule } from "expo";

// The native player (modules/player): one Media3 ExoPlayer for the whole app. Every command names
// the attempt it is for and answers false when that attempt is no longer the one playing, or the
// command doesn't apply to it (seeking a live stream). Observations name their attempt too.

/** What a source's address answers with: HLS, MPEG-TS, or a file whose container is read from it. */
export type StreamFormat = "hls" | "mpegts" | "progressive";

/** Live, a catch-up recording, a movie or episode, or a downloaded file. */
export type PlaybackMode = "live" | "archive" | "title" | "file";

/** What an attempt holds open while it plays. */
export type HoldRef =
  | { readonly kind: "source"; readonly sourceId: string }
  | { readonly kind: "file"; readonly path: string };

/**
 * One attempt to play. `url` and `headers` can hold a login: they go to the native player only,
 * never into state, storage or logs.
 */
export interface Admission {
  readonly attempt: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly format: StreamFormat;
  readonly mode: PlaybackMode;
  /** Where a title, recording or file starts, in ms. Live starts at its live edge. */
  readonly startMs: number;
  readonly sourceId?: string;
  readonly path?: string;
}

export type NativePhase =
  "preparing" | "buffering" | "playing" | "paused" | "ended" | "failed" | "stopped";

/**
 * Why playback failed: `network` (unreachable or timed out), `http` (the provider answered
 * `status`), `cleartext`, `file-missing`, `format` (not a stream this reads), `decoder` or
 * `unsupported` (nothing in it this phone decodes), or `unexpected`. `code` is Media3's name.
 */
export interface NativeFailure {
  readonly kind:
    | "network"
    | "http"
    | "cleartext"
    | "file-missing"
    | "format"
    | "decoder"
    | "unsupported"
    | "unexpected";
  readonly code: string;
  readonly status: number | null;
}

export interface Observation {
  readonly attempt: string;
  readonly phase: NativePhase;
  readonly positionMs: number;
  /** Null for live, and while the media hasn't said. */
  readonly durationMs: number | null;
  readonly bufferedMs: number;
  readonly live: boolean;
  readonly seekable: boolean;
  readonly speed: number;
  readonly failure: NativeFailure | null;
}

/** A track the media declares, and whether this phone decodes it. */
export interface Track {
  /** Pass it back to `setQuality` for a video track. */
  readonly id: string;
  readonly type: "video" | "audio" | "text";
  /** The MIME type of its samples: "video/avc", "audio/mp4a-latm". */
  readonly codec: string | null;
  readonly language: string | null;
  readonly label: string | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly bitrate: number | null;
  readonly channels: number | null;
  readonly selected: boolean;
  readonly supported: boolean;
}

/**
 * How an attempt let go of what it held. `file-closed`: its file is closed. `connections-closed`:
 * this phone closed every connection it opened; whether the provider counted them as ended can't
 * be observed. `unconfirmed`: a reader was still open ten seconds after the attempt ended.
 */
export interface Release {
  readonly attempt: string;
  readonly hold: HoldRef;
  readonly outcome: "file-closed" | "connections-closed" | "unconfirmed";
}

/** What this phone declares it decodes, by MIME type, and the containers the player reads. */
export interface Capabilities {
  readonly containers: readonly string[];
  readonly decoders: Readonly<
    Record<string, { readonly decoder: boolean; readonly hardware: boolean }>
  >;
}

type Listener<T> = (event: T) => void;

export interface NativePlayer {
  admit(admission: Admission): Promise<void>;
  pause(attempt: string): Promise<boolean>;
  resume(attempt: string): Promise<boolean>;
  seek(attempt: string, positionMs: number): Promise<boolean>;
  setSpeed(attempt: string, speed: number): Promise<boolean>;
  /** A video track's id, or null to choose by itself again. */
  setQuality(attempt: string, trackId: string | null): Promise<boolean>;
  stop(attempt: string): Promise<boolean>;
  capabilities(): Capabilities;
  addListener(event: "onState", listener: Listener<Observation>): { remove(): void };
  addListener(
    event: "onTracks",
    listener: Listener<{ attempt: string; tracks: readonly Track[] }>,
  ): { remove(): void };
  addListener(event: "onReleased", listener: Listener<Release>): { remove(): void };
}

export const nativePlayer = (): NativePlayer => requireNativeModule<NativePlayer>("Player");
