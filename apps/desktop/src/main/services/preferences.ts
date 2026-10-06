// Viewing settings in preferences.json. Two kinds share the file, as they always have, so the
// newest stable release reads and writes it too. Preferences hold whichever subscription plays:
// volume, mute, languages, the quality live channels start in. What the viewer left a subscription
// at is that subscription's alone, because every id in it is its provider's own: the last channel
// and category, and the versions and streams picked. Those are read and changed by naming the
// subscription, and one that isn't saved has none. Reads and changes take turns at the file, and
// one that names a subscription checks that it is the saved one when its turn comes: the
// subscription may have been replaced while it waited.
import { join } from "node:path";
import {
  defaultPreferences,
  defaultSubscriptionPreferences,
  Preferences,
  SubscriptionPreferences,
} from "@mrstreamer/contracts/preferences";
import { Failed } from "@mrstreamer/core/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";
import { Subscriptions } from "./subscription.ts";

/**
 * preferences.json as stored: the preferences, and what the viewer left the saved subscription
 * at. Files from before the viewing record also carry its two lists; they stay in the file until
 * the record has imported them. Keys of newer versions are kept.
 */
const Stored = Preferences.merge(SubscriptionPreferences).merge({
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
     * What the viewer left the subscription at. Fails with `no-subscription`, as changing it
     * does, when that subscription isn't the saved one.
     */
    ofSubscription(subscriptionId: string): Effect.Effect<SubscriptionPreferences, Failed>;
    updateSubscription(
      subscriptionId: string,
      patch: Partial<SubscriptionPreferences>,
    ): Effect.Effect<SubscriptionPreferences, Failed>;
    /**
     * Forgets what the viewer left the subscription at, for when it changes or goes: what was
     * watched last and the versions and channel streams picked. Lists not yet imported go too:
     * they belong to the account before.
     */
    readonly forget: Effect.Effect<void>;
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
    const subscriptions = yield* Subscriptions;
    const path = join(dataDir, "preferences.json");
    const one = yield* Semaphore.make(1);
    let current: Stored | null = null;

    /** The file as last read or written. Only runs while holding `one`. */
    const stored = Effect.promise(async () => {
      current ??= (await readJsonFile(path, Stored)) ?? {
        ...defaultPreferences,
        ...defaultSubscriptionPreferences,
      };
      return current;
    });

    /** Applies a change to the file and writes it. Only runs while holding `one`. */
    const applied = (apply: (previous: Stored) => Stored) =>
      Effect.gen(function* () {
        const next = apply(yield* stored);
        yield* Effect.promise(() => writeJsonFile(path, next));
        current = next;
        return next;
      });

    const change = (apply: (previous: Stored) => Stored) => one.withPermits(1)(applied(apply));

    /**
     * Passes when `subscriptionId` is the saved subscription, whose the file's own are, also
     * while its password or link can't be read.
     */
    const saved = (subscriptionId: string) =>
      Effect.flatMap(subscriptions.get, (subscription) =>
        subscription?.id === subscriptionId
          ? Effect.void
          : Effect.fail(new Failed({ error: { kind: "no-subscription" } })),
      );

    /**
     * Runs `effect` on the file's own while `subscriptionId` is the saved subscription. It is
     * checked with the file in hand, not before: a call can wait behind others, and by its turn
     * the file may be another subscription's.
     */
    const whileSaved = <A>(subscriptionId: string, effect: Effect.Effect<A>) =>
      one.withPermits(1)(Effect.andThen(saved(subscriptionId), effect));

    return {
      get: one.withPermits(1)(Effect.map(stored, general)),
      update: (patch: Partial<Preferences>) =>
        Effect.map(
          change((previous) => ({ ...previous, ...patch })),
          general,
        ),
      ofSubscription: (subscriptionId: string) =>
        whileSaved(subscriptionId, Effect.map(stored, ofSaved)),
      updateSubscription: (subscriptionId: string, patch: Partial<SubscriptionPreferences>) =>
        whileSaved(
          subscriptionId,
          Effect.map(
            applied((previous) => ({ ...previous, ...patch })),
            ofSaved,
          ),
        ),
      forget: Effect.asVoid(
        change((previous) => ({ ...general(previous), ...defaultSubscriptionPreferences })),
      ),
      legacyLists: one.withPermits(1)(
        Effect.map(stored, ({ favouriteChannelIds, recentChannelIds }) =>
          favouriteChannelIds || recentChannelIds
            ? { favourites: favouriteChannelIds ?? [], recent: recentChannelIds ?? [] }
            : null,
        ),
      ),
      dropLegacyLists: Effect.gen(function* () {
        const { favouriteChannelIds, recentChannelIds } = yield* one.withPermits(1)(stored);
        if (favouriteChannelIds || recentChannelIds) {
          yield* change(({ favouriteChannelIds: _f, recentChannelIds: _r, ...kept }) => kept);
        }
      }),
    };
  });
}

/** The file's preferences, without what belongs to its subscription or to the viewing record. */
function general({
  lastChannelId: _channel,
  lastCategoryId: _category,
  titleVersions: _versions,
  channelVariants: _variants,
  favouriteChannelIds: _favourites,
  recentChannelIds: _recent,
  ...preferences
}: Stored): Preferences {
  return preferences;
}

/** What the file keeps for the saved subscription. */
function ofSaved({
  lastChannelId,
  lastCategoryId,
  titleVersions,
  channelVariants,
}: Stored): SubscriptionPreferences {
  return {
    lastChannelId,
    lastCategoryId,
    ...(titleVersions ? { titleVersions } : {}),
    ...(channelVariants ? { channelVariants } : {}),
  };
}
