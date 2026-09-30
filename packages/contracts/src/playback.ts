// Stream sessions: the main process opens the upstream connection and hands the UI a local URL.

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
] as const;
export type Codec = (typeof CODECS)[number];

export interface StreamSession {
  readonly sessionId: string;
  readonly channelId: string;
  /** Loopback URL that proxies the provider stream. Carries no credentials. */
  readonly url: string;
  readonly format: StreamFormat;
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
