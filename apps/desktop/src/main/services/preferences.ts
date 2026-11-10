import type { Json } from "@mrstreamer/contracts/json";
import { t } from "@mrstreamer/core/i18n";

import { type, type Type } from "arktype";
import { readFile } from "node:fs/promises";
import { LiveDiscovery, RememberedLiveBrowse } from "@mrstreamer/contracts/live-browse";
import { ownedId, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { homeRows } from "@mrstreamer/core/home/rows";
import { isDeepStrictEqual } from "node:util";
import type { UsageObservers } from "../analytics/observers.ts";
import {
  DEFAULT_LIVE_QUALITY,
  DEFAULT_NEXT_EPISODE_DELAY,
  DEFAULT_SUBTITLE_LOOK,
} from "@mrstreamer/contracts/preferences";
// Viewing settings in preferences.json. Two kinds share the file, as they always have, so the
// newest stable release reads and writes it too. Preferences hold whichever subscription plays:
// volume, mute, languages, the quality live channels start in. What the viewer left a subscription
// at is that subscription's alone, because every id in it is its provider's own: the last channel
// and category, and the versions and streams picked. The file keeps those of the original
// subscription, the one older releases know; a subscription added beside it keeps its own in a
// preferences.json in its folder, which holds nothing else. Those are read and changed by naming
// the subscription, and one that isn't saved has none. Reads and changes take turns at the files,
// and one that names a subscription checks that it is saved when its turn comes: the subscription
// may have gone while it waited. The interface language is kept beside them, and changed only
// through `setInterfaceLanguage`.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DEFAULT_PROFILE_ID, type ActiveProfile } from "@mrstreamer/contracts/profiles";
import { profileDirectory } from "../platform/profile-store.ts";
import type { LanguageChoice } from "@mrstreamer/contracts/language";
import {
  defaultPreferences,
  defaultSubscriptionPreferences,
  Preferences,
  MultiviewLayout,
  SubscriptionPreferences,
} from "@mrstreamer/contracts/preferences";
import { Failed } from "@mrstreamer/core/failure";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import { readJson, readJsonFile, writeJsonFile } from "../platform/json-file.ts";
import { Subscriptions, type SavedSubscription } from "./subscription.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { defined } from "@mrstreamer/core/defined";

/**
 * preferences.json as stored: the preferences, and what the viewer left the original subscription
 * at. Files from before the viewing record also carry its two lists; they stay in the file until
 * the record has imported them. Keys of newer versions are kept.
 */
const Stored = lazy(() =>
  Preferences()
    .omit("nextEpisodeDelaySeconds", "multiviewLayouts")
    .merge(SubscriptionPreferences())
    .merge({
      "favouriteChannelIds?": "string[]",
      "recentChannelIds?": "string[]",
      /**
       * The interface language picked in Settings: a `Locale`, or "system". Any string, so a language
       * a later release adds doesn't make this one drop the file. System default when absent.
       */
      "interfaceLanguage?": "string",
    }),
);

type Stored = Infer<typeof Stored> & {
  /** Preserve malformed and future values until the viewer explicitly replaces this leaf. */
  nextEpisodeDelaySeconds?: Json;
  multiviewLayouts?: Json;
  rememberedLiveBrowse?: Json;
};

async function readStored(path: string): Promise<Stored | null> {
  const data = await readJson(path);
  const parsed = Stored()(data);

  if (data !== null && parsed instanceof type.errors) {
    console.warn(
      `[storage] ignoring ${path}: ${parsed.map((error) => `${error.path}: ${error.expected}`).join("; ")}`,
    );
  }

  if (
    parsed instanceof type.errors ||
    data === null ||
    !type.keywords.object.root.allows(data) ||
    Array.isArray(data)
  )
    return null;

  return { ...data, ...parsed };
}

/** Private files have no legacy downgrade contract: only a missing file starts with defaults. */
async function readPrivatePreferences<T>(
  path: string,
  schema: Type<T>,
): Promise<Type<T>["infer"] | null> {
  let bytes: string;

  try {
    bytes = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }

  // Parser diagnostics can echo stored values, including the viewer's private API key.
  try {
    const data: unknown = JSON.parse(bytes);
    const parsed = schema(data);

    if (!(parsed instanceof type.errors)) return parsed;
  } catch {
    // Preserve the failed file, but never include its contents in an error or log.
  }

  throw new Error(t("Viewing preferences could not be read. Repair the file or switch profiles."));
}

/** Installation consent remains owned by Analytics, including while another viewer is active. */
export interface InstallationConsent {
  readonly read: Effect.Effect<boolean>;
  readonly write: (enabled: boolean) => Effect.Effect<void>;
}

export class Settings extends Context.Service<
  Settings,
  {
    readonly get: Effect.Effect<Preferences>;
    /**
     * Discovery only, which a list of the viewer's is part of. Favourites, Recently watched and
     * session filters never reach this file.
     */
    readonly liveBrowse: Effect.Effect<LiveDiscovery>;
    rememberLiveBrowse(selection: LiveDiscovery): Effect.Effect<LiveDiscovery, Failed>;
    update(patch: Partial<Preferences>): Effect.Effect<Preferences>;
    /** The interface language as saved, which may be one this release doesn't know. */
    readonly interfaceLanguage: Effect.Effect<string | undefined>;
    setInterfaceLanguage(choice: LanguageChoice): Effect.Effect<void>;
    /**
     * What the viewer left the subscription at. Fails with `no-subscription`, as changing it
     * does, when that subscription isn't saved.
     */
    ofSubscription(subscriptionId: string): Effect.Effect<SubscriptionPreferences, Failed>;
    updateSubscription(
      subscriptionId: string,
      patch: Partial<SubscriptionPreferences>,
    ): Effect.Effect<SubscriptionPreferences, Failed>;
    /**
     * Forgets what the viewer left `subscription` at, for when it goes: what was watched last and
     * the versions and channel streams picked. For the original, lists not yet imported go too:
     * they belong to its account. Snapshot effective discovery before the folder is removed, so
     * a prior stable category edit keeps precedence while the surviving baseline changes. The
     * returned effect settles admitted writes after logical removal and before folder deletion.
     * A newer explicit choice wins over the captured one.
     */
    prepareForget(subscription: SavedSubscription): Effect.Effect<Effect.Effect<void>>;

    /** The favourites and recent channels of a file from before the viewing record, or null. */
    readonly legacyLists: Effect.Effect<{
      readonly favourites: readonly string[];
      readonly recent: readonly string[];
    } | null>;
    /** Takes the lists out of the file, once the viewing record has them. */
    readonly dropLegacyLists: Effect.Effect<void>;
  }
>()("mrstreamer/Settings") {
  /** Reads the saved choice before the runtime exists, so startup errors use its language. */
  static async readInterfaceLanguage(dataDir: string): Promise<string | undefined> {
    const saved = await readStored(join(dataDir, "preferences.json"));

    return saved?.interfaceLanguage;
  }

  /** Default's settings keep their original paths. */
  static readonly layer = (dataDir: string, usage?: UsageObservers) =>
    Layer.effect(Settings, make(dataDir, usage, DEFAULT_PROFILE_ID));

  /** Private viewing settings with a live overlay from the installation's consent owner. */
  static readonly profileLayer = (
    dataDir: string,
    profileId: string,
    consent: InstallationConsent,
    usage?: UsageObservers,
  ) =>
    Layer.effect(
      Settings,
      Effect.map(make(dataDir, usage, profileId), (settings) =>
        withInstallationConsent(settings, consent),
      ),
    );
}

function make(dataDir: string, usage: UsageObservers | undefined, profileId: string) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const personalDir = profileDirectory(dataDir, profileId);
    const path = join(personalDir, "preferences.json");
    const one = yield* Semaphore.make(1);
    let current: Stored | null = null;
    /** What the viewer left each added subscription at, by its id, as last read or written. */
    const added = new Map<string, SubscriptionPreferences>();

    /** The file as last read or written. Only runs while holding `one`. */
    const stored = Effect.promise(async () => {
      // Default retains the format handling older releases use at its original path.
      current ??= (await (profileId === DEFAULT_PROFILE_ID
        ? readStored(path)
        : readPrivatePreferences(path, Stored()))) ?? {
        ...defaultPreferences,
        ...defaultSubscriptionPreferences,
      };

      return current;
    });

    /**
     * Applies a change while holding `one`. The native write and in-memory publication finish
     * in that same turn even if the caller cancels.
     */
    const applied = (apply: (previous: Stored) => Stored) =>
      Effect.gen(function* () {
        const previous = yield* stored;
        const next = apply(previous);
        const changed = preferenceChanges(previous, next).map((key) => usage?.setting(key));
        yield* Effect.promise(() => writeJsonFile(path, next));
        current = next;

        for (const note of changed) note?.();

        return next;
      }).pipe(Effect.uninterruptible);

    const change = (apply: (previous: Stored) => Stored) => one.withPermits(1)(applied(apply));

    /** The saved subscription `subscriptionId` names, also while its secret can't be read. */
    const saved = (subscriptionId: string) =>
      Effect.flatMap(subscriptions.saved, (all) => {
        const found = all.find((each) => each.id === subscriptionId);

        return found
          ? Effect.succeed(found)
          : Effect.fail(new Failed({ error: { kind: "no-subscription" } }));
      });

    /**
     * Runs `run` for the subscription `subscriptionId` names while it is saved. It is looked up
     * with the files in hand, not before: a call can wait behind others, and by its turn the
     * subscription may have gone.
     */
    const whileSaved = <A>(
      subscriptionId: string,
      run: (subscription: SavedSubscription) => Effect.Effect<A>,
    ) => one.withPermits(1)(Effect.flatMap(saved(subscriptionId), run));

    const addedPath = (subscription: SavedSubscription) =>
      profileId === DEFAULT_PROFILE_ID
        ? join(subscription.dir, "preferences.json")
        : join(
            personalDir,
            "subscriptions",
            createHash("sha256").update(subscription.id).digest("hex"),
            "preferences.json",
          );

    /** Commits the added source's file and cached value together while holding `one`. */
    const saveAdded = (subscription: SavedSubscription, next: SubscriptionPreferences) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeJsonFile(addedPath(subscription), next));
        added.set(subscription.id, next);

        return next;
      }).pipe(Effect.uninterruptible);

    /** What the viewer left an added subscription at. Only runs while holding `one`. */
    const ofAdded = (subscription: SavedSubscription) =>
      Effect.promise(async () => {
        const kept =
          added.get(subscription.id) ??
          (await (profileId === DEFAULT_PROFILE_ID
            ? readJsonFile(addedPath(subscription), SubscriptionPreferences())
            : readPrivatePreferences(addedPath(subscription), SubscriptionPreferences()))) ??
          defaultSubscriptionPreferences;

        added.set(subscription.id, kept);

        return kept;
      });

    const leftAt = (subscription: SavedSubscription) =>
      subscription.original ? Effect.map(stored, ofOriginal) : ofAdded(subscription);

    /** The one pair startup in prior stable would restore, not every subscription's history. */
    const legacy = (saved: readonly SavedSubscription[]) =>
      Effect.gen(function* () {
        for (const subscription of saved) {
          const { lastCategoryId } = yield* leftAt(subscription);

          if (lastCategoryId !== null)
            return { subscriptionId: subscription.id, id: lastCategoryId };
        }

        return null;
      });

    const readBrowse = Effect.gen(function* () {
      const saved = yield* subscriptions.saved;
      const baseline = yield* legacy(saved);
      const raw = RememberedLiveBrowse()((yield* stored).rememberedLiveBrowse);

      if (!(raw instanceof type.errors) && sameBaseline(raw.legacy, baseline)) {
        // A topic and a list of the viewer's are anyone's, whichever subscriptions are saved.
        if ((raw.selection.kind === "topic" || raw.selection.kind === "custom") && saved.length > 0)
          return discoverySelection(raw.selection);
        const selection = raw.selection;

        if (
          selection.kind === "category" &&
          saved.some((each) => each.id === selection.category.subscriptionId)
        )
          return discoverySelection(selection);
      }

      return baseline
        ? { kind: "category" as const, category: baseline }
        : { kind: "all" as const };
    });

    const writeLeft = (subscription: SavedSubscription, lastCategoryId: string | null) =>
      Effect.gen(function* () {
        const previous = yield* leftAt(subscription);

        if (previous.lastCategoryId === lastCategoryId) return;

        if (subscription.original) yield* applied((file) => ({ ...file, lastCategoryId }));
        else {
          yield* saveAdded(subscription, { ...previous, lastCategoryId });
        }
      });

    return {
      get: one.withPermits(1)(Effect.map(stored, effective)),
      liveBrowse: one.withPermits(1)(readBrowse),
      rememberLiveBrowse: (input: LiveDiscovery) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            const selection = discoverySelection(input);
            const all = yield* subscriptions.saved;

            if (all.length === 0 && selection.kind !== "all")
              return yield* new Failed({ error: { kind: "no-subscription" } });

            if (selection.kind === "category") yield* saved(selection.category.subscriptionId);

            // A topic or a list of the viewer's leaves the category each subscription opens on.
            if (selection.kind === "category" || selection.kind === "all") {
              for (const subscription of all)
                yield* writeLeft(
                  subscription,
                  selection.kind === "category" &&
                    selection.category.subscriptionId === subscription.id
                    ? selection.category.id
                    : null,
                );
            }

            const baseline = yield* legacy(all);
            yield* applied(({ rememberedLiveBrowse: _old, ...file }) =>
              selection.kind === "all"
                ? file
                : {
                    ...file,
                    rememberedLiveBrowse: { version: 1, selection, legacy: baseline },
                  },
            );

            return discoverySelection(selection);
          }),
        ),
      update: (patch: Partial<Preferences>) =>
        Effect.map(
          change((previous) => {
            const next = { ...previous, ...patch };

            // Replace visible layouts while retaining entries this release cannot edit.
            if (patch.multiviewLayouts !== undefined && Array.isArray(previous.multiviewLayouts))
              next.multiviewLayouts = [
                ...patch.multiviewLayouts,
                ...previous.multiviewLayouts.filter((layout) => !MultiviewLayout().allows(layout)),
              ];

            return next;
          }),
          effective,
        ),
      interfaceLanguage: one.withPermits(1)(Effect.map(stored, (file) => file.interfaceLanguage)),
      setInterfaceLanguage: (choice: LanguageChoice) =>
        Effect.asVoid(change((previous) => ({ ...previous, interfaceLanguage: choice }))),
      ofSubscription: (subscriptionId: string) =>
        whileSaved(subscriptionId, (subscription) =>
          subscription.original ? Effect.map(stored, ofOriginal) : ofAdded(subscription),
        ),
      updateSubscription: (subscriptionId: string, patch: Partial<SubscriptionPreferences>) =>
        whileSaved(subscriptionId, (subscription) =>
          subscription.original
            ? Effect.map(
                applied((previous) => ({ ...previous, ...patch })),
                ofOriginal,
              )
            : Effect.gen(function* () {
                const next = { ...(yield* ofAdded(subscription)), ...patch };

                return yield* saveAdded(subscription, next);
              }),
        ),
      prepareForget: (subscription: SavedSubscription) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            const before = (yield* stored).rememberedLiveBrowse;
            const selectionBeforeRemoval = yield* readBrowse;

            return one.withPermits(1)(
              Effect.gen(function* () {
                const previous = yield* stored;
                const raw = previous.rememberedLiveBrowse;
                const record = RememberedLiveBrowse()(raw);

                const remaining = (yield* subscriptions.saved).filter(
                  (each) => each.id !== subscription.id,
                );

                // Unknown future records survive both removal paths verbatim.
                let rememberedLiveBrowse = raw;

                if (!(record instanceof type.errors)) {
                  const selection = raw === before ? selectionBeforeRemoval : record.selection;

                  const valid =
                    remaining.length > 0 &&
                    (selection.kind === "topic" ||
                      selection.kind === "custom" ||
                      remaining.some(
                        (each) =>
                          selection.kind === "category" &&
                          each.id === selection.category.subscriptionId,
                      ));

                  rememberedLiveBrowse = valid
                    ? { ...record, selection, legacy: yield* legacy(remaining) }
                    : undefined;
                }

                if (subscription.original || !(record instanceof type.errors)) {
                  yield* applied((file) => {
                    const { rememberedLiveBrowse: _remembered, ...kept } = subscription.original
                      ? {
                          ...general(file),
                          ...defaultSubscriptionPreferences,
                          ...defined({ interfaceLanguage: file.interfaceLanguage }),
                        }
                      : file;

                    return {
                      ...kept,
                      ...defined({ rememberedLiveBrowse }),
                    };
                  });
                }

                added.delete(subscription.id);
              }),
            );
          }),
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

/**
 * The file's preferences, without what belongs to its subscription or to the viewing record, or
 * the interface language or remembered discovery.
 */
function general({
  lastChannelId: _channel,
  lastCategoryId: _category,
  titleVersions: _versions,
  channelVariants: _variants,
  favouriteChannelIds: _favourites,
  recentChannelIds: _recent,
  interfaceLanguage: _language,
  rememberedLiveBrowse: _browse,
  ...preferences
}: Stored) {
  return preferences;
}

/** Normalize replies only. File reconstruction must keep unsupported raw values intact. */
function effective(file: Stored): Preferences {
  const { nextEpisodeDelaySeconds, multiviewLayouts, ...preferences } = general(file);

  const layouts = Array.isArray(multiviewLayouts)
    ? multiviewLayouts.filter((layout) => MultiviewLayout().allows(layout))
    : [];

  return {
    ...preferences,
    ...(layouts.length > 0 && { multiviewLayouts: layouts }),
    nextEpisodeDelaySeconds:
      type("number | number.NaN").allows(nextEpisodeDelaySeconds) &&
      Number.isInteger(nextEpisodeDelaySeconds) &&
      nextEpisodeDelaySeconds >= 0 &&
      nextEpisodeDelaySeconds <= 60
        ? nextEpisodeDelaySeconds
        : DEFAULT_NEXT_EPISODE_DELAY,
  };
}

/** What the file keeps for the original subscription. */
function ofOriginal({
  lastChannelId,
  lastCategoryId,
  titleVersions,
  channelVariants,
}: Stored): SubscriptionPreferences {
  return {
    lastChannelId,
    lastCategoryId,
    ...defined({ titleVersions, channelVariants }),
  };
}

/** Compare effective defaults inside the file serializer. Values never leave Settings. */
function preferenceChanges(before: Stored, after: Stored) {
  const keys = [
    [
      "interface_language",
      before.interfaceLanguage ?? "system",
      after.interfaceLanguage ?? "system",
    ],
    ["audio_language", before.audioLanguage ?? null, after.audioLanguage ?? null],
    ["subtitle_language", before.subtitleLanguage ?? null, after.subtitleLanguage ?? null],
    ["title_language", before.titleLanguage ?? "en", after.titleLanguage ?? "en"],
    [
      "live_quality",
      before.liveQuality ?? DEFAULT_LIVE_QUALITY,
      after.liveQuality ?? DEFAULT_LIVE_QUALITY,
    ],
    ["autoplay_next", before.autoplayNext ?? true, after.autoplayNext ?? true],
    [
      "subtitle_look",
      before.subtitleLook ?? DEFAULT_SUBTITLE_LOOK,
      after.subtitleLook ?? DEFAULT_SUBTITLE_LOOK,
    ],
    ["home_rows", homeRows(before.homeRows), homeRows(after.homeRows)],
  ] as const;

  return keys.flatMap(([key, previous, next]) => (isDeepStrictEqual(previous, next) ? [] : [key]));
}

function sameBaseline(a: OwnedId | null, b: OwnedId | null): boolean {
  return a === null ? b === null : b !== null && sameOwned(a, b);
}

/** Only supported discovery fields are effective; raw future extras stay in the stored leaf. */
function discoverySelection(selection: LiveDiscovery): LiveDiscovery {
  switch (selection.kind) {
    case "topic":
      return { kind: "topic", topic: selection.topic };
    case "category":
      return { kind: "category", category: ownedId(selection.category) };
    case "custom":
      return { kind: "custom", id: selection.id };
    case "all":
      return { kind: "all" };
  }
}

/** Overlay the live installation owner; no profile file stores or copies consent. */
export function withInstallationConsent(
  settings: Settings["Service"],
  consent: InstallationConsent,
): Settings["Service"] {
  const get = Effect.gen(function* () {
    const personal = yield* settings.get;

    return { ...personal, analyticsEnabled: yield* consent.read };
  });

  return {
    ...settings,
    get,
    update: (patch) =>
      Effect.gen(function* () {
        const { analyticsEnabled, ...personal } = patch;

        if (analyticsEnabled !== undefined) yield* consent.write(analyticsEnabled);

        if (Object.keys(personal).length > 0) yield* settings.update(personal);

        return yield* get;
      }),
  };
}

/** Captured preferences for shared catalogue reads admitted by the window. */
export class AdmittedSettings extends Context.Service<
  AdmittedSettings,
  {
    readonly owner: ActiveProfile;
    readonly settings: Settings["Service"];
    readonly current: () => boolean;
  }
>()("mrstreamer/AdmittedSettings") {}

/** Shared catalogue facts may be reused; an admitted viewer's preferences are read only for it. */
export function viewingPreferences(fallback: Settings["Service"]) {
  return Effect.flatMap(Effect.serviceOption(AdmittedSettings), (admitted) => {
    if (admitted._tag === "None") return fallback.get;

    return Effect.andThen(
      Effect.sync(() => {
        if (!admitted.value.current())
          throw new Error("Viewing profile changed; retry this catalogue read.");
      }),
      admitted.value.settings.get,
    );
  });
}
