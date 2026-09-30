// Viewing settings in preferences.json: volume, mute, and the last channel and category. Changes
// apply and write one at a time, in call order.
import { join } from "node:path";
import { defaultPreferences, Preferences } from "@mrstreamer/contracts/preferences";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";

/**
 * preferences.json as stored. Files from before the viewing record also carry its two lists; they
 * stay in the file until the record has imported them. Keys of newer versions are kept.
 */
const Stored = Preferences.merge({
  "favouriteChannelIds?": "string[]",
  "recentChannelIds?": "string[]",
});
type Stored = typeof Stored.infer;

export class Settings extends Context.Service<
  Settings,
  {
    readonly get: Effect.Effect<Preferences>;
    update(patch: Partial<Preferences>): Effect.Effect<Preferences>;
    /**
     * Forgets what was watched last, for when the subscription changes or goes. Lists not yet
     * imported go too: they belong to the account before.
     */
    readonly forget: Effect.Effect<Preferences>;
    /** The favourites and recent channels of a file from before the viewing record, or null. */
    readonly legacyLists: Effect.Effect<{
      readonly favourites: readonly string[];
      readonly recent: readonly string[];
    } | null>;
    /** Takes the lists out of the file, once the viewing record has them. */
    readonly dropLegacyLists: Effect.Effect<void>;
  }
>()("mrstreamer/Settings") {
  /** Settings in `dataDir`. */
  static readonly layer = (dataDir: string) => Layer.effect(Settings, make(dataDir));
}

function make(dataDir: string) {
  return Effect.gen(function* () {
    const path = join(dataDir, "preferences.json");
    const one = yield* Semaphore.make(1);
    let current: Stored | null = null;

    /** The file as last read or written. Only runs while holding `one`. */
    const stored = Effect.promise(async () => {
      current ??= (await readJsonFile(path, Stored)) ?? defaultPreferences;
      return current;
    });

    const change = (apply: (previous: Stored) => Stored) =>
      one.withPermits(1)(
        Effect.gen(function* () {
          const next = apply(yield* stored);
          yield* Effect.promise(() => writeJsonFile(path, next));
          current = next;
          return withoutLists(next);
        }),
      );

    return {
      get: one.withPermits(1)(Effect.map(stored, withoutLists)),
      update: (patch: Partial<Preferences>) => change((previous) => ({ ...previous, ...patch })),
      forget: change((previous) => ({
        ...withoutLists(previous),
        lastChannelId: null,
        lastCategoryId: null,
      })),
      legacyLists: one.withPermits(1)(
        Effect.map(stored, ({ favouriteChannelIds, recentChannelIds }) =>
          favouriteChannelIds || recentChannelIds
            ? { favourites: favouriteChannelIds ?? [], recent: recentChannelIds ?? [] }
            : null,
        ),
      ),
      dropLegacyLists: Effect.gen(function* () {
        const { favouriteChannelIds, recentChannelIds } = yield* one.withPermits(1)(stored);
        if (favouriteChannelIds || recentChannelIds) yield* change(withoutLists);
      }),
    };
  });
}

function withoutLists({
  favouriteChannelIds: _favourites,
  recentChannelIds: _recent,
  ...preferences
}: Stored): Preferences {
  return preferences;
}
