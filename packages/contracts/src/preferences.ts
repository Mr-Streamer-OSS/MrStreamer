import { type } from "arktype";

/**
 * Basic viewing preferences that survive restarts. Favourites and recently watched channels live
 * in the viewing record instead; files from before it may still carry them until imported.
 */
export const Preferences = type({
  volume: "0 <= number <= 1",
  muted: "boolean",
  lastChannelId: "string | null",
  lastCategoryId: "string | null",
  /** The sound language picked last for a movie or episode: "nl". Absent until one is picked. */
  "audioLanguage?": "string | null",
  /** The subtitle language picked last, or "off" once subtitles were turned off. */
  "subtitleLanguage?": "string | null",
});
export type Preferences = typeof Preferences.infer;

export const defaultPreferences: Preferences = {
  volume: 1,
  muted: false,
  lastChannelId: null,
  lastCategoryId: null,
};
