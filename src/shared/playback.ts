// Stream sessions: the main process opens the upstream connection and hands the UI a local URL.

/** Container formats the UI's playback engines know how to load. */
export type StreamFormat = "mpegts" | "hls";

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
  | { readonly kind: "network"; readonly detail: string };
