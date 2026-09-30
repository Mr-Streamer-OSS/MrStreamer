// Stream sessions: the main process opens the upstream connection and hands the UI a local URL.
import type { TitleRef } from "./ondemand.ts";

/** Container formats the UI's playback engines know how to load. */
export type StreamFormat = "mpegts" | "hls";

/**
 * Codecs the app tells apart in a stream. The UI reports which of them its player decodes, and
 * the main process converts the rest before they reach it.
 */
export const CODECS = [
  "h264",
  "hevc",
  "hevc-10bit",
  "mpeg2",
  "aac",
  /** AAC whose channel layout is only described in the stream, which browsers do not read. */
  "aac-pce",
  "aac-latm",
  "mp3",
  "mp2",
  "ac3",
  "eac3",
  "dts",
  "opus",
  "flac",
] as const;
export type Codec = (typeof CODECS)[number];

export interface StreamSession {
  readonly sessionId: string;
  readonly channelId: string;
  /** Loopback URL that proxies the provider stream. Carries no credentials. */
  readonly url: string;
  readonly format: StreamFormat;
}

/**
 * A movie or episode ready to play. The player asks `url` for the picture and sound from a
 * position, with a chosen sound track and optionally a subtitle track:
 * `${url}?start=<seconds>&audio=<id>&subtitle=<id>`. Each request starts again from its position
 * and replaces the one before, so seeking and changing tracks never hold two provider
 * connections. The answer is fragmented MP4; its `x-start` header says at which second of the
 * title its first frame sits, and `x-cues` names where the subtitle cues stream, as WebVTT with
 * the title's own times.
 */
export interface TitleSession {
  readonly sessionId: string;
  readonly title: TitleRef;
  /** Loopback URL. Carries no credentials. */
  readonly url: string;
  /** Seconds, or null when the file does not say. */
  readonly duration: number | null;
  /** Sound tracks in the file's order. */
  readonly audio: readonly AudioTrack[];
  /** Subtitle tracks in the file's order, including ones that can't be shown. */
  readonly subtitles: readonly SubtitleTrack[];
}

export interface AudioTrack {
  /** The track's number in the file; pass it back to choose it. */
  readonly id: number;
  /** ISO 639 language code as the file names it, or null. */
  readonly language: string | null;
  /** "English · 5.1" */
  readonly label: string;
  /** The file marks it as the one to play by default. */
  readonly default: boolean;
}

export interface SubtitleTrack {
  readonly id: number;
  readonly language: string | null;
  /** "Nederlands", "English · SDH", "Deutsch · Forced" */
  readonly label: string;
  /** Only for scenes in another language, such as signs and foreign dialogue. */
  readonly forced: boolean;
  readonly default: boolean;
  /** False for subtitles stored as pictures, which the player can't show. */
  readonly text: boolean;
}

/** Why the provider did not deliver a stream. */
export type StreamFailure =
  /** 401/403 and similar: wrong login, or every allowed connection is in use. */
  | { readonly kind: "refused"; readonly status: number }
  /** 404/410: the channel has no stream right now. */
  | { readonly kind: "unavailable"; readonly status: number }
  | { readonly kind: "provider-error"; readonly status: number }
  /** No response before the timeout, or the connection dropped. */
  | { readonly kind: "network"; readonly detail: string }
  /** The stream arrived, but its format cannot be played or converted here. */
  | { readonly kind: "unsupported"; readonly detail: string };
