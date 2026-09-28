import { join } from "node:path";
import { defaultPreferences, Preferences, RECENT_LIMIT } from "../../shared/preferences.ts";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";

export type PreferenceStore = ReturnType<typeof createPreferences>;

/** Viewing preferences stored in the app's data folder. Updates are applied and written in call order. */
export function createPreferences(dataDir: string) {
  const path = join(dataDir, "preferences.json");
  let current: Promise<Preferences> | null = null;
  let writes: Promise<void> = Promise.resolve();

  function get(): Promise<Preferences> {
    current ??= readJsonFile(path, Preferences).then((stored) => stored ?? defaultPreferences);
    return current;
  }

  async function change(apply: (previous: Preferences) => Preferences): Promise<Preferences> {
    const next = get().then(apply);
    current = next;
    const value = await next;
    writes = writes.then(() => writeJsonFile(path, value));
    await writes;
    return value;
  }

  return {
    get,

    update(patch: Partial<Preferences>): Promise<Preferences> {
      return change((previous) => ({ ...previous, ...patch }));
    },

    /** Makes a channel the last watched one and moves it to the front of the recent list. */
    recordWatch(channelId: string): Promise<Preferences> {
      return change((previous) => ({
        ...previous,
        lastChannelId: channelId,
        recentChannelIds: [
          channelId,
          ...previous.recentChannelIds.filter((id) => id !== channelId),
        ].slice(0, RECENT_LIMIT),
      }));
    },
  };
}
