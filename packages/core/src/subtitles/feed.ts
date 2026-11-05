import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";
// A movie's or episode's subtitles as the proxy sends them to the player: a JSON line each, with
// times in seconds into the title. The feed recovers what precedes the position and says `ready`
// when it has that past. Independent text can arrive and show meanwhile; packet changes wait
// for `ready` because their decoder may depend on earlier packets.

/**
 * Why a track has nothing to show for a position: reading it would take more of the provider than
 * playback spares, the provider put another file behind the address, the file isn't laid out in a
 * way that can be read for it, or the provider didn't answer.
 */
export type SubtitlesUnavailable = "limit" | "changed" | "unreadable" | "network";

/** One line of the feed. */
export type SubtitleFeedLine =
  /**
   * Without `at`, all history needed at the position has been sent: held packet changes can
   * show and text's history is complete. With `at`, output resumes from that later time after
   * unavailable history.
   */
  | { readonly ready: true; readonly at?: number }
  /**
   * The past can't be recovered. Packet state is cleared and output resumes at the feed's next
   * ready boundary. Independent text keeps showing and arriving, unless `changed` says its
   * file was replaced and clears it too.
   */
  | { readonly unavailable: SubtitlesUnavailable }
  /** A packet for the player's decoder, in base64. */
  | { readonly at: number; readonly data: string }
  /** A line of text, shown from `at` until `until`. */
  | { readonly at: number; readonly until: number; readonly text: string };

// Branch order is part of the feed: ready/unavailable take precedence over packet fields.
const Ready = lazy(() => type({ ready: "true" }));
const TimedReady = lazy(() => Ready().and({ at: "number" }));

const Unavailable = lazy(() =>
  type({ unavailable: "'limit' | 'changed' | 'unreadable' | 'network'" }),
);

const Packet = lazy(() => type({ at: "number", data: "string" }));
const Text = lazy(() => type({ at: "number", text: "string", until: "number" }));

/** What a line of the feed says, or null when it isn't one. */
export function readFeedLine(line: string): SubtitleFeedLine | null {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }

  if (!type.keywords.object.root.allows(value)) return null;

  if ("ready" in value) {
    if (!Ready().allows(value)) return null;

    return TimedReady().allows(value) ? { ready: true, at: value.at } : { ready: true };
  }

  if ("unavailable" in value) {
    return Unavailable().allows(value) ? { unavailable: value.unavailable } : null;
  }

  if (Packet().allows(value)) return { at: value.at, data: value.data };

  if (Text().allows(value)) return { at: value.at, until: value.until, text: value.text };

  return null;
}
