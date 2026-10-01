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
  /**
   * The sound to play: "nl", or ORIGINAL_SOUND for the language a title was made in. Set in
   * Settings, and by the sound track picked last. Absent plays the language for movies and series.
   */
  "audioLanguage?": "string | null",
  /**
   * Subtitles to show: a language, "off" for none, or absent or null for only those forced for
   * the sound's language. Set in Settings, and by the subtitles picked last.
   */
  "subtitleLanguage?": "string | null",
  /**
   * The language for movies and series, an ISO 639-1 code: which version of a film shows and
   * plays first, and the sound until another is picked. English when absent.
   */
  "titleLanguage?": "string",
  /** The viewer's own TMDB key or read access token, used instead of the app's. */
  "tmdbKey?": "string",
  /** Titles the provider marks for adults show, in their own tab. Off when absent. */
  "adultTitles?": "boolean",
  /**
   * The version the viewer picked for a movie or series, by kind and TMDB id: "movie:603" to the
   * version's id. Titles without one play the version that suits them best.
   */
  "titleVersions?": "Record<string, string>",
});
export type Preferences = typeof Preferences.infer;

/** `audioLanguage` for the sound in the language a title was made in. */
export const ORIGINAL_SOUND = "original";

export const defaultPreferences: Preferences = {
  volume: 1,
  muted: false,
  lastChannelId: null,
  lastCategoryId: null,
};
