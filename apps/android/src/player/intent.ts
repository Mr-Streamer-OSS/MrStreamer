import { type } from "arktype";
import type { ArchiveWindow } from "@mrstreamer/contracts/playback";

/**
 * What to play, as screens name it: no address and no login, so an intent can sit in a route's
 * params, state or a log. The player works out the address itself (./resolve.ts).
 *
 * - `live`: a channel at its live edge.
 * - `catch-up`: a stretch of a channel's past from its provider's archive, which keeps `days`;
 *   from `from` (epoch ms) when given, else from the window's start.
 * - `title`: a movie or an episode, from `resumeAt` ms when given.
 * - `file`: a file on this phone, such as a download, from `resumeAt` ms when given.
 */
export type PlayIntent =
  | {
      readonly kind: "live";
      readonly sourceId: string;
      readonly channelId: string;
      readonly title: string;
    }
  | {
      readonly kind: "catch-up";
      readonly sourceId: string;
      readonly channelId: string;
      readonly title: string;
      readonly window: ArchiveWindow;
      readonly days: number;
      readonly from?: number;
    }
  | {
      readonly kind: "title";
      readonly sourceId: string;
      readonly media: "movie" | "episode";
      readonly id: string;
      /** The file's extension as the provider lists it: "mkv", "mp4". */
      readonly container: string;
      readonly title: string;
      readonly resumeAt?: number;
    }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly title: string;
      readonly resumeAt?: number;
    };

/** The same for intents that play the same thing, whatever position they start from. */
export function intentKey(intent: PlayIntent): string {
  switch (intent.kind) {
    case "live":
      return JSON.stringify([intent.kind, intent.sourceId, intent.channelId]);
    case "catch-up":
      return JSON.stringify([
        intent.kind,
        intent.sourceId,
        intent.channelId,
        intent.window.start,
        intent.window.end,
      ]);
    case "title":
      return JSON.stringify([intent.kind, intent.sourceId, intent.media, intent.id]);
    case "file":
      return JSON.stringify([intent.kind, intent.path]);
  }
}

const window = type({ start: "number", end: "number" });
/** An intent a link can carry: not a file, which only the app itself names. */
const Linked = type({
  kind: "'live'",
  sourceId: "string",
  channelId: "string",
  title: "string",
})
  .or({
    kind: "'catch-up'",
    sourceId: "string",
    channelId: "string",
    title: "string",
    window,
    days: "number",
    "from?": "number",
  })
  .or({
    kind: "'title'",
    sourceId: "string",
    media: "'movie' | 'episode'",
    id: "string",
    container: "string",
    title: "string",
    "resumeAt?": "number",
  });

/**
 * Watch's route for `intent`, which the caller plays first: what plays sits in the route's params,
 * so a Watch opened again finds it. A file's path stays out of the route.
 */
export const watchHref = (intent: PlayIntent) =>
  intent.kind === "file"
    ? ({ pathname: "/watch" } as const)
    : ({ pathname: "/watch", params: { play: JSON.stringify(intent) } } as const);

/**
 * The intent in Watch's `play` param, or null when there is none or it isn't one a link can carry.
 * Files are played by the app's own screens only: a link never names a path.
 */
export function linkedIntent(param: string | string[] | undefined): PlayIntent | null {
  if (typeof param !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(param);
  } catch {
    return null;
  }
  const parsed = Linked(value);
  return parsed instanceof type.errors ? null : parsed;
}
