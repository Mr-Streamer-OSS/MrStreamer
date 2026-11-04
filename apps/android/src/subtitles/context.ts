import type { SubtitleTitle } from "./model.ts";

/** Playback details supply exact episode identity without guessing numbers from a display label. */
const titles = new Map<string, SubtitleTitle>();

export const versionKey = (source: string, kind: string, id: string, container: string) =>
  JSON.stringify([source, kind, id, container]);

export function rememberSubtitleTitle(title: SubtitleTitle) {
  titles.set(title.key, title);
}

export function knownSubtitleTitle(key: string) {
  return titles.get(key);
}
