// Online search is opt-in. Saved account secrets and service download URLs never leave main.
import { type } from "arktype";

export const SUBTITLE_SERVICES = ["subdl", "opensubtitles"] as const;
export type SubtitleService = (typeof SUBTITLE_SERVICES)[number];

export const SubtitleTiming = type({
  offset: "-600 <= number <= 600",
  /** Subtitle clock multiplied by this ratio, then shifted by offset seconds. */
  speed: "0.9 <= number <= 1.1",
});
export type SubtitleTiming = typeof SubtitleTiming.infer;
export const DEFAULT_SUBTITLE_TIMING: SubtitleTiming = { offset: 0, speed: 1 };

export const OnlineSubtitlePreferences = type({
  enabled: "boolean",
  languages: "string[] <= 10",
  service: "'both' | 'subdl' | 'opensubtitles'",
});
export type OnlineSubtitlePreferences = typeof OnlineSubtitlePreferences.infer;

export interface OnlineSubtitleSettings extends OnlineSubtitlePreferences {
  /** Presence only. Secrets are entered again to replace them, never echoed. */
  readonly configured: Readonly<Record<SubtitleService, boolean>>;
}

export interface SubtitleCredentials {
  readonly subdl?: { readonly apiKey: string } | null;
  readonly opensubtitles?: {
    readonly apiKey: string;
    readonly username: string;
    readonly password: string;
  } | null;
}

export interface OnlineSubtitleResult {
  /** Opaque main-owned search result. Choosing it explicitly may consume a service download. */
  readonly id: string;
  readonly service: SubtitleService;
  readonly language: string;
  readonly release: string;
  readonly hearingImpaired: boolean;
  readonly downloads: number | null;
}

export type SubtitleServiceFailure =
  "not-configured" | "credentials" | "quota" | "unavailable" | "unsupported";

export interface OnlineSubtitleSearch {
  readonly results: readonly OnlineSubtitleResult[];
  readonly failures: readonly {
    readonly service: SubtitleService;
    readonly reason: SubtitleServiceFailure;
  }[];
}

export const DownloadedSubtitle = type({
  service: "'subdl' | 'opensubtitles'",
  language: "string <= 64",
  release: "string <= 1024",
  cues: type({
    start: "0 <= number <= 86400",
    end: "0 < number <= 86400",
    text: "string <= 32768",
  })
    .narrow(({ start, end }) => end > start)
    .array()
    .atMostLength(100000)
    .narrow((cues) => cues.reduce((size, cue) => size + cue.text.length, 0) <= 10 * 1024 * 1024),
});
export type DownloadedSubtitle = typeof DownloadedSubtitle.infer;

export const SavedSubtitle = type({
  timing: SubtitleTiming,
  subtitle: DownloadedSubtitle.or("null"),
});
export type SavedSubtitle = typeof SavedSubtitle.infer;
