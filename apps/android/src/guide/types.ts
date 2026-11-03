export interface SourceLogin {
  readonly login: readonly string[];
  readonly uncertain?: readonly string[];
}

/** Successor owners admit these intents; this service performs none of their side effects. */
export type ProgrammeIntent = {
  readonly kind: "watch-live" | "catch-up" | "remind";
  readonly sourceId: string;
  readonly channelId: string;
  readonly start: number;
};
