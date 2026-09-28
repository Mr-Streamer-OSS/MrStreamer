import { type } from "arktype";

/** How many channels the recently watched list keeps. */
export const RECENT_LIMIT = 12;

/** Basic viewing preferences that survive restarts. */
export const Preferences = type({
  volume: "0 <= number <= 1",
  muted: "boolean",
  lastChannelId: "string | null",
  lastCategoryId: "string | null",
  /** Most recent first. Files written before this field existed read as an empty list. */
  recentChannelIds: ["string[]", "=", () => []],
});
export type Preferences = typeof Preferences.infer;

export const defaultPreferences: Preferences = {
  volume: 1,
  muted: false,
  lastChannelId: null,
  lastCategoryId: null,
  recentChannelIds: [],
};
