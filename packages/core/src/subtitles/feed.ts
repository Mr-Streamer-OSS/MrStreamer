// A movie's or episode's subtitles as the proxy sends them to the player: a JSON line each, with
// times in seconds into the title. First what the file holds before the position, as far back as
// the subtitles on screen there depend on, then `ready`, then each one as the run reads it.

/**
 * Why a track has nothing to show for a position: reading it would take more of the provider than
 * playback spares, the provider put another file behind the address, the file isn't laid out in a
 * way that can be read for it, or the provider didn't answer.
 */
export type SubtitlesUnavailable = "limit" | "changed" | "unreadable" | "network";

/** One line of the feed. */
export type SubtitleFeedLine =
  /**
   * Everything before the position has been sent: the player can show the track. With `at`, only
   * from that time on: the track starts afresh there, after a position it had nothing for.
   */
  | { readonly ready: true; readonly at?: number }
  /** What the track holds before the position can't be had: the player shows nothing of it. */
  | { readonly unavailable: SubtitlesUnavailable }
  /** A packet for the player's decoder, in base64. */
  | { readonly at: number; readonly data: string }
  /** A line of text, shown from `at` until `until`. */
  | { readonly at: number; readonly until: number; readonly text: string };

/** What a line of the feed says, or null when it isn't one. */
export function readFeedLine(line: string): SubtitleFeedLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  if ("ready" in value) {
    if (value.ready !== true) return null;
    return "at" in value && typeof value.at === "number"
      ? { ready: true, at: value.at }
      : { ready: true };
  }
  if ("unavailable" in value) {
    const why = value.unavailable;
    return why === "limit" || why === "changed" || why === "unreadable" || why === "network"
      ? { unavailable: why }
      : null;
  }
  if (!("at" in value) || typeof value.at !== "number") return null;
  if ("data" in value && typeof value.data === "string") return { at: value.at, data: value.data };
  if (
    "text" in value &&
    typeof value.text === "string" &&
    "until" in value &&
    typeof value.until === "number"
  ) {
    return { at: value.at, until: value.until, text: value.text };
  }
  return null;
}
