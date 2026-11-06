import { t } from "@mrstreamer/core/i18n";
import { Library } from "./library.ts";
import { OnDemand } from "./ondemand.ts";
import { Watchlist } from "./watchlist.ts";
import { CustomLists } from "./custom-lists.ts";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import {
  DEFAULT_PROFILE_ID,
  sameProfile,
  type ActiveProfile,
} from "@mrstreamer/contracts/profiles";
import {
  ViewingStore,
  ViewingRecord,
  ViewingProfile,
  ViewingErasure,
  LegacyViewing,
  ViewingAccount,
  ViewingChannels,
  ViewingSeries,
} from "@mrstreamer/core/viewing/service";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import { defined } from "@mrstreamer/core/defined";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { profileDirectory, profileStorage } from "../platform/profile-store.ts";
import { WatchlistStore, watchlistStoreLayer } from "../platform/watchlist-store.ts";
import { CustomListStore, customListStoreLayer } from "../platform/custom-lists-store.ts";
import {
  Settings,
  AdmittedSettings,
  withInstallationConsent,
  type InstallationConsent,
} from "./preferences.ts";
import { Subscriptions, type SavedSubscription } from "./subscription.ts";
import type { UsageObservers } from "../analytics/observers.ts";
import * as Layer from "effect/Layer";
import { Database, databaseLayer } from "../platform/database.ts";
import { observedViewingStoreLayer } from "../platform/viewing-store.ts";

/**
 * Construct once for an admitted owner and retain the returned services for late reads, writes
 * and retries. No operation looks up the active viewer. This is a storage seam, not permission
 * to activate another profile; playback and event routing must be isolated before enabling it.
 */
export function personalStoresLayer({
  dataDir,
  profileId,
  usage,
  database,
}: {
  readonly dataDir: string;
  readonly profileId: string;
  readonly usage?: UsageObservers;
  /** Reuse the runtime's connection when binding Default's existing state. */
  readonly database?: Layer.Layer<Database>;
}) {
  if (database && profileId !== DEFAULT_PROFILE_ID) {
    throw new Error("Only Default may reuse the installation database.");
  }

  return Layer.mergeAll(
    observedViewingStoreLayer(usage),
    watchlistStoreLayer,
    customListStoreLayer,
  ).pipe(Layer.provide(database ?? databaseLayer(profileDirectory(dataDir, profileId))));
}

/** Captured record for receiver callbacks that outlive the request which opened them. */
export class AdmittedViewing extends Context.Service<
  AdmittedViewing,
  {
    readonly record: ViewingRecord["Service"];
    readonly run: ProfileAdmission["run"];
  }
>()("mrstreamer/AdmittedViewing") {}

// Operations each hold one permit. Erasure/deletion take them all after invalidating admissions.
const PROFILE_OPERATIONS = Number.MAX_SAFE_INTEGER;

type ProfileUpdate =
  | { readonly kind: "active"; readonly active: ActiveProfile }
  | { readonly kind: "viewing"; readonly owner: ActiveProfile | null; readonly sequence: number }
  | { readonly kind: "watchlist" | "lists" | "erased"; readonly owner: ActiveProfile | null };

/** The complete personal service environment an admitted operation may use. */
type PersonalServices =
  | ViewingStore
  | WatchlistStore
  | CustomListStore
  | Settings
  | ViewingRecord
  | Watchlist
  | CustomLists;

export interface ProfileAdmission {
  readonly owner: ActiveProfile;
  readonly services: {
    readonly viewing: ViewingRecord["Service"];
    readonly watchlist: Watchlist["Service"];
    readonly lists: CustomLists["Service"];
    readonly settings: Settings["Service"];
  };
  /** A retained admission never resolves the active owner again, even when run much later. */
  readonly run: <A, E>(work: Effect.Effect<A, E, PersonalServices>) => Effect.Effect<A, E | Failed>;
}

/**
 * Backend lifecycle only. Callers must complete playback/event/query isolation before exposing
 * create or switch. Switching requires an explicit interactive cleanup callback and leaves
 * household services and their runtimes alone.
 */
export function makeProfiles({
  dataDir,
  stopInteractive,
  configured,
  usage,
  consent,
}: {
  readonly dataDir: string;
  readonly consent?: InstallationConsent;
  readonly stopInteractive?: () => Effect.Effect<void, Failed>;
  readonly usage?: UsageObservers;
  readonly configured?: (
    settings: Settings["Service"],
    owner: ActiveProfile,
  ) => Effect.Effect<void, Failed>;
}) {
  return Effect.gen(function* () {
    const storage = yield* profileStorage;
    const events = yield* PubSub.unbounded<ProfileUpdate>();
    const scope = yield* Effect.scope;
    const subscriptions = yield* Subscriptions;

    const shared = yield* Effect.context<
      Subscriptions | Library | OnDemand | ViewingAccount | ViewingChannels | ViewingSeries
    >();

    const original = yield* Effect.context<PersonalServices>();
    const one = yield* Semaphore.make(1);
    let active = yield* storage.active;
    let configuredFor: string | null = active.id === DEFAULT_PROFILE_ID ? active.id : null;
    let configurationFailure: Failed | null = null;

    const handles = new Map<
      string,
      {
        readonly context: Context.Context<PersonalServices>;
        readonly dispose: () => Promise<void>;
        readonly one: Semaphore.Semaphore;
        closed: boolean;
        readonly erased: Map<string, number>;
      }
    >();

    const refused = (detail: string) => new Failed({ error: { kind: "unexpected", detail } });
    /** Whether `owner` is still the active visit; a retained admission answers this later. */
    const isActive = (owner: ActiveProfile) => sameProfile(owner, active);

    const existing = (id: string) =>
      Effect.flatMap(storage.list, (rows) => {
        const found = rows.find((row) => row.id === id);

        return found && !found.deleting
          ? Effect.succeed(found)
          : Effect.fail(refused(t("This viewing profile is unavailable or being deleted.")));
      });

    const opened = (id: string) =>
      Effect.gen(function* () {
        const retained = handles.get(id);

        if (retained) {
          if (retained.closed) return yield* refused(t("This viewing profile is being deleted."));

          return retained;
        }

        yield* existing(id);

        if (id !== DEFAULT_PROFILE_ID && !consent)
          return yield* refused(t("Profile switching requires the installation consent owner."));

        const settings = (
          consent
            ? Settings.profileLayer(dataDir, id, consent, usage)
            : Settings.layer(dataDir, usage)
        ).pipe(Layer.provide(Layer.succeed(Subscriptions, subscriptions)));

        const stores = personalStoresLayer({ dataDir, profileId: id, ...defined({ usage }) });
        const personal = Layer.mergeAll(stores, settings);

        const features = Layer.mergeAll(
          ViewingRecord.layer.pipe(
            Layer.provide(
              Layer.effect(
                LegacyViewing,
                Effect.map(Settings, (settings) => ({
                  take: settings.legacyLists,
                  drop: settings.dropLegacyLists,
                })),
              ),
            ),
          ),
          Watchlist.layer,
          CustomLists.layer,
        ).pipe(Layer.provideMerge(personal), Layer.provide(Layer.succeedContext(shared)));

        const runtime = id === DEFAULT_PROFILE_ID ? null : ManagedRuntime.make(features);

        const context = runtime
          ? yield* Effect.tryPromise({ try: () => runtime.context(), catch: failedWith }).pipe(
              Effect.onError(() => Effect.promise(() => runtime.dispose())),
            )
          : consent
            ? Context.add(
                original,
                Settings,
                withInstallationConsent(Context.get(original, Settings), consent),
              )
            : original;

        const handle = {
          context,
          dispose: () => runtime?.dispose() ?? Promise.resolve(),
          one: yield* Semaphore.make(PROFILE_OPERATIONS),
          closed: false,
          erased: new Map<string, number>(),
        };

        // Probe before caching or starting watches, so a failed open remains retryable.
        yield* Context.get(context, CustomListStore).lists.pipe(
          Effect.onError(() => Effect.promise(handle.dispose)),
        );
        handles.set(id, handle);

        const viewing = Context.get(context, ViewingRecord);
        const watchlist = Context.get(context, Watchlist);
        const lists = Context.get(context, CustomLists);

        const watches = [
          Stream.runForEach(
            viewing.profileChanges ??
              Stream.map(viewing.changes, (sequence) => ({ owner: null, sequence })),
            (change) => PubSub.publish(events, { kind: "viewing", ...change }),
          ),
          Stream.runForEach(
            watchlist.profileChanges ?? Stream.map(watchlist.changes, () => null),
            (owner) => PubSub.publish(events, { kind: "watchlist", owner }),
          ),
          Stream.runForEach(
            lists.profileChanges ?? Stream.map(lists.changes, () => null),
            (owner) => PubSub.publish(events, { kind: "lists", owner }),
          ),
        ];

        for (const watch of watches) {
          if (runtime) runtime.runFork(watch);
          else yield* Effect.forkIn(watch, scope);
        }

        return handle;
      });

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const handle of handles.values()) handle.closed = true;

        for (const handle of handles.values()) await handle.dispose();
      }),
    );

    const expectedOwner = (expected?: ActiveProfile) =>
      Effect.suspend(() =>
        expected && !isActive(expected)
          ? Effect.fail(refused(t("Viewing profile changed; retry this request.")))
          : Effect.void,
      );

    const admitFor = (expected?: ActiveProfile) =>
      one.withPermits(1)(
        Effect.gen(function* () {
          if (configuredFor !== active.id)
            return yield* configurationFailure ??
              refused(
                t(
                  "Viewing profile configuration did not finish; select the profile again to retry.",
                ),
              );

          yield* expectedOwner(expected);
          const owner = { ...active };
          const handle = yield* opened(owner.id);
          const erased = new Map(handle.erased);

          const erasure = {
            current: (account: string) =>
              (erased.get(account) ?? 0) === (handle.erased.get(account) ?? 0),
          };

          const run: ProfileAdmission["run"] = (work) =>
            Effect.suspend(() => {
              if (handle.closed)
                return Effect.fail(
                  refused(t("This profile admission has ended; retry the operation.")),
                );

              return handle.one.withPermits(1)(
                Effect.gen(function* () {
                  if (handle.closed)
                    return yield* refused(
                      t("This profile admission has ended; retry the operation."),
                    );

                  return yield* Effect.provideContext(
                    work,
                    Context.add(
                      Context.add(
                        Context.add(
                          Context.add(handle.context, ViewingErasure, erasure),
                          ViewingProfile,
                          owner,
                        ),
                        AdmittedViewing,
                        {
                          record: Context.get(handle.context, ViewingRecord),
                          run,
                        },
                      ),
                      AdmittedSettings,
                      {
                        owner,
                        settings: Context.get(handle.context, Settings),
                        current: () => isActive(owner),
                      },
                    ),
                  );
                }),
              );
            });

          return {
            owner,
            run,
            services: {
              viewing: Context.get(handle.context, ViewingRecord),
              watchlist: Context.get(handle.context, Watchlist),
              lists: Context.get(handle.context, CustomLists),
              settings: Context.get(handle.context, Settings),
            },
          } satisfies ProfileAdmission;
        }),
      );

    const configure = (context: Context.Context<PersonalServices>, owner: ActiveProfile) =>
      Effect.gen(function* () {
        const catalogue = yield* Effect.exit(
          Effect.provideService(Context.get(shared, OnDemand).reconfigure, AdmittedSettings, {
            owner,
            settings: Context.get(context, Settings),
            current: () => isActive(owner),
          }),
        );

        if (Exit.isFailure(catalogue))
          return yield* Effect.fail(failedWith(Cause.squash(catalogue.cause)));

        // Configuration holds the lifecycle lock: the captured owner and Settings cannot change
        // before this completes. Failure keeps admissions closed for the existing retry path; a
        // typed Failed keeps its advice and a thrown callback becomes Failed.
        if (configured)
          yield* Effect.suspend(() =>
            configured(Context.get(context, Settings), { ...owner }),
          ).pipe(Effect.catchDefect((defect) => Effect.fail(failedWith(defect))));
      });

    if (configuredFor === null) {
      yield* Effect.flatMap(opened(active.id), (restored) =>
        configure(restored.context, { ...active }),
      ).pipe(
        Effect.match({
          onFailure: (failure) => {
            configurationFailure = failure;
          },
          onSuccess: () => {
            configuredFor = active.id;
          },
        }),
      );
    }

    const activeRead: Effect.Effect<ActiveProfile, Failed> = Effect.sync(() => ({ ...active }));

    return {
      changes: Stream.fromPubSub(events),
      list: storage.list,
      active: activeRead,
      create: (name: string, expected?: ActiveProfile) =>
        one.withPermits(1)(
          Effect.andThen(
            expectedOwner(expected),
            Effect.suspend(() => {
              const trimmed = name.trim();

              return trimmed.length > 0 && trimmed.length <= 80
                ? storage.create(randomUUID(), trimmed)
                : Effect.fail(
                    new Failed({
                      error: {
                        kind: "invalid-input",
                        detail: t("A profile name must contain 1 to 80 characters."),
                      },
                    }),
                  );
            }),
          ),
        ),
      admit: admitFor(),
      // Old/bootstrap desktop calls can address only the original Default revision. Missing
      // metadata must never retarget a queued request after a switch, including away and back.
      admitFor: (expected?: ActiveProfile) =>
        admitFor(expected ?? { id: DEFAULT_PROFILE_ID, revision: 1 }),
      switch: (id: string, expected?: ActiveProfile) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            // Retrying the same durably selected owner also retries its unfinished configuration.
            yield* expectedOwner(expected);

            if (id === active.id && configuredFor === id) return { ...active };

            if (!stopInteractive)
              return yield* refused(
                t("Profile switching is not enabled until interactive isolation is ready."),
              );
            const next = yield* opened(id);

            if (configuredFor !== null) {
              const previous = yield* opened(active.id);
              const leaving = { ...active };
              yield* Effect.provideService(stopInteractive(), AdmittedSettings, {
                owner: leaving,
                settings: Context.get(previous.context, Settings),
                current: () => isActive(leaving),
              });
            }

            // Publish only after the durable selection commits; a failed save leaves the old owner.
            if (id !== active.id) active = yield* storage.select(id);
            configuredFor = null;
            // While the lifecycle lock holds, no new-owner request reaches the shared catalogue
            // before its existing worker has adopted this owner's TMDB configuration.
            yield* configure(next.context, { ...active }).pipe(
              Effect.tapError((failure) =>
                Effect.sync(() => {
                  configurationFailure = failure;
                }),
              ),
            );
            configurationFailure = null;
            configuredFor = id;
            yield* PubSub.publish(events, { kind: "active", active: { ...active } });

            return { ...active };
          }),
        ),
      remove: (id: string, expected?: ActiveProfile) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            yield* expectedOwner(expected);
            // Persist the tombstone before waiting for pending operations or touching files. A failed
            // close keeps both the directory and registry row for retry, including after restart.
            yield* storage.deleting(id);
            const handle = handles.get(id);

            if (handle) {
              handle.closed = true;
              yield* handle.one.withPermits(PROFILE_OPERATIONS)(
                Effect.tryPromise({ try: handle.dispose, catch: failedWith }),
              );
            }

            yield* Effect.tryPromise({
              try: () => rm(profileDirectory(dataDir, id), { recursive: true, force: true }),
              catch: failedWith,
            });
            yield* storage.removed(id);
            handles.delete(id);
          }),
        ),
      prepareForget: (
        subscription: SavedSubscription,
        defaultForget?: ReturnType<Settings["Service"]["prepareForget"]>,
      ) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            const settled = yield* Effect.forEach(yield* storage.list, (row) =>
              Effect.gen(function* () {
                if (row.deleting) return Effect.void;
                const handle = yield* opened(row.id);

                const settle = yield* row.id === DEFAULT_PROFILE_ID && defaultForget
                  ? defaultForget
                  : Context.get(handle.context, Settings).prepareForget(subscription);

                // Settlement runs after household admission ends; deletion still drains this owner.
                return handle.one.withPermits(1)(
                  Effect.gen(function* () {
                    if (handle.closed) return;
                    yield* settle;
                  }),
                );
              }),
            );

            return Effect.asVoid(Effect.forEach(settled, (settle) => settle));
          }),
        ),
      eraseSource: (account: string, defaultErase?: Effect.Effect<void, Failed>) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            const admitted = { ...active };

            // Invalidate every retained callback before opening or erasing any owner can fail.
            for (const handle of handles.values())
              handle.erased.set(account, (handle.erased.get(account) ?? 0) + 1);
            const rows = yield* storage.list;

            if (rows.some((row) => row.deleting))
              return yield* refused(
                t("Finish deleting the pending profile before erasing a source."),
              );

            // Separate owner databases cannot commit atomically together. Completed erasures remain
            // erased if a later owner fails. Return that failure; retrying erases the entire set again.
            for (const row of rows) {
              const handle = yield* opened(row.id);
              yield* handle.one.withPermits(PROFILE_OPERATIONS)(
                row.id === DEFAULT_PROFILE_ID && defaultErase
                  ? defaultErase
                  : Context.get(handle.context, ViewingRecord).erase(account),
              );
              yield* PubSub.publish(events, {
                kind: "erased",
                owner: row.id === admitted.id ? admitted : null,
              });
            }
          }),
        ),
    };
  });
}

export class ProfileSessions extends Context.Service<
  ProfileSessions,
  Effect.Success<ReturnType<typeof makeProfiles>>
>()("mrstreamer/ProfileSessions") {
  static readonly layer = (options: Parameters<typeof makeProfiles>[0]) =>
    Layer.effect(
      ProfileSessions,
      Effect.gen(function* () {
        // Admission retries failed registry initialization. Do not turn a locked database at
        // startup into guessed state, or poison all later calls with a cached failure.
        const context = yield* Effect.context<Effect.Services<ReturnType<typeof makeProfiles>>>();
        const scope = yield* Scope.Scope;
        const one = yield* Semaphore.make(1);
        let current: ProfileSessions["Service"] | undefined;

        const ready = one.withPermits(1)(
          Effect.suspend(() =>
            current
              ? Effect.succeed(current)
              : makeProfiles(options).pipe(
                  Effect.provideContext(Context.add(context, Scope.Scope, scope)),
                  Effect.tap((made) =>
                    Effect.sync(() => {
                      current = made;
                    }),
                  ),
                ),
          ),
        );

        return {
          changes: Stream.unwrap(Effect.map(ready, (profiles) => profiles.changes)).pipe(
            Stream.orDie,
          ),
          list: Effect.flatMap(ready, (profiles) => profiles.list),
          active: Effect.flatMap(ready, (profiles) => profiles.active),
          admit: Effect.flatMap(ready, (profiles) => profiles.admit),
          admitFor: (owner?: ActiveProfile) =>
            Effect.flatMap(ready, (profiles) => profiles.admitFor(owner)),
          create: (name: string, expected?: ActiveProfile) =>
            Effect.flatMap(ready, (profiles) => profiles.create(name, expected)),
          switch: (id: string, expected?: ActiveProfile) =>
            Effect.flatMap(ready, (profiles) => profiles.switch(id, expected)),
          remove: (id: string, expected?: ActiveProfile) =>
            Effect.flatMap(ready, (profiles) => profiles.remove(id, expected)),
          prepareForget: (
            subscription: SavedSubscription,
            defaultForget?: ReturnType<Settings["Service"]["prepareForget"]>,
          ) =>
            Effect.flatMap(ready, (profiles) =>
              profiles.prepareForget(subscription, defaultForget),
            ),
          eraseSource: (account: string, defaultErase?: Effect.Effect<void, Failed>) =>
            Effect.flatMap(ready, (profiles) => profiles.eraseSource(account, defaultErase)),
        };
      }),
    );
}
