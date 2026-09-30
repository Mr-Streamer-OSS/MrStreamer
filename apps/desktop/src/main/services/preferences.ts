import { join } from "node:path";
import { defaultPreferences, Preferences } from "@mrstreamer/contracts/preferences";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";

/**
 * preferences.json as stored. Files from before the viewing record also carry its two lists; they
 * stay in the file until the record has imported them.
 */
const Stored = Preferences.merge({
  "favouriteChannelIds?": "string[]",
  "recentChannelIds?": "string[]",
}).onUndeclaredKey("delete");
type Stored = typeof Stored.infer;

/** Viewing preferences stored in the app's data folder. Updates are applied and written in call order. */
export function createPreferences(dataDir: string) {
  const path = join(dataDir, "preferences.json");
  let current: Promise<Stored> | null = null;
  let writes: Promise<void> = Promise.resolve();

  function stored(): Promise<Stored> {
    current ??= readJsonFile(path, Stored).then((file) => file ?? defaultPreferences);
    return current;
  }

  async function change(apply: (previous: Stored) => Stored): Promise<Preferences> {
    const next = stored().then(apply);
    current = next;
    const value = await next;
    writes = writes.then(() => writeJsonFile(path, value));
    await writes;
    return withoutLists(value);
  }

  return {
    get: (): Promise<Preferences> => stored().then(withoutLists),

    update(patch: Partial<Preferences>): Promise<Preferences> {
      return change((previous) => ({ ...previous, ...patch }));
    },

    /**
     * Forgets what was watched last, for when the subscription changes or goes. Lists not yet
     * imported go too: they belong to the account before.
     */
    forget(): Promise<Preferences> {
      return change((previous) => ({
        ...withoutLists(previous),
        lastChannelId: null,
        lastCategoryId: null,
      }));
    },

    /** The favourites and recent channels of a file from before the viewing record, or null. */
    async legacyLists(): Promise<{ favourites: string[]; recent: string[] } | null> {
      const { favouriteChannelIds, recentChannelIds } = await stored();
      if (!favouriteChannelIds && !recentChannelIds) return null;
      return { favourites: favouriteChannelIds ?? [], recent: recentChannelIds ?? [] };
    },

    /** Takes the lists out of the file, once the viewing record has them. */
    async dropLegacyLists(): Promise<void> {
      const { favouriteChannelIds, recentChannelIds } = await stored();
      if (favouriteChannelIds || recentChannelIds) await change(withoutLists);
    },
  };
}

export type PreferencesService = ReturnType<typeof createPreferences>;

function withoutLists({
  favouriteChannelIds: _favourites,
  recentChannelIds: _recent,
  ...preferences
}: Stored): Preferences {
  return preferences;
}
