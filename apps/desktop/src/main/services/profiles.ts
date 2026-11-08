import { AdmittedKids, allowsApproval } from "./profile-policy.ts";
import { t } from "@mrstreamer/core/i18n";
import { Library } from "./library.ts";
import { OnDemand } from "./ondemand.ts";
import { Watchlist } from "./watchlist.ts";
import { CustomLists } from "./custom-lists.ts";
import { Collections } from "./collections.ts";
import { type } from "arktype";
import {
  KidsProfilePolicySchema,
  type KidsPolicy,
  type KidsApproval,
} from "@mrstreamer/contracts/profiles";
import { transaction } from "../platform/database.ts";
import { randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
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
import { CollectionsStore, collectionsStoreLayer } from "../platform/collections-store.ts";
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
    collectionsStoreLayer,
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
  | {
      readonly kind: "watchlist" | "lists" | "collections" | "erased";
      readonly owner: ActiveProfile | null;
    };

/** The complete personal service environment an admitted operation may use. */
type PersonalServices =
  | ViewingStore
  | WatchlistStore
  | CustomListStore
  | CollectionsStore
  | Collections
  | Settings
  | ViewingRecord
  | Watchlist
  | CustomLists;

export interface ProfileAdmission {
  readonly owner: ActiveProfile;
  readonly current: Effect.Effect<void, Failed>;
  readonly approved: readonly KidsApproval[] | null;
  readonly services: {
    readonly viewing: ViewingRecord["Service"];
    readonly watchlist: Watchlist["Service"];
    readonly lists: CustomLists["Service"];
    readonly collections: Collections["Service"];
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
    const database = yield* Database;

    const policyFailure = () =>
      new Failed({
        error: {
          kind: "unexpected",
          detail: t("Kids policy could not be read or saved. Try again."),
        },
      });

    const policySchema = type({
      pin: "string",
      salt: "string",
      revision: "number.integer >= 1",
      profiles: KidsProfilePolicySchema().array(),
    });

    const db = () => {
      if (!("db" in database)) throw policyFailure();

      return database.db;
    };

    yield* Effect.try({
      try: () =>
        transaction(db(), () => {
          const existed = db()
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kids_policy'")
            .get();

          db().exec(
            "CREATE TABLE IF NOT EXISTS kids_policy (id INTEGER PRIMARY KEY CHECK(id = 1), value TEXT NOT NULL)",
          );

          if (!existed)
            db()
              .prepare("INSERT INTO kids_policy VALUES (1, ?)")
              .run(JSON.stringify({ pin: "", salt: "", revision: 1, profiles: [] }));
        }),
      catch: policyFailure,
    });

    const readPolicy = Effect.try({
      try: () => {
        const row = db().prepare("SELECT value FROM kids_policy WHERE id = 1").get();

        if (!row || !type("string").allows(row.value)) throw policyFailure();
        const parsed = policySchema(JSON.parse(row.value));

        if (
          parsed instanceof type.errors ||
          (parsed.pin === ""
            ? parsed.profiles.length !== 0 || parsed.salt !== ""
            : !/^[0-9a-f]{64}$/.test(parsed.pin) || !parsed.salt) ||
          parsed.profiles.some((row) => row.id === DEFAULT_PROFILE_ID)
        )
          throw policyFailure();

        return parsed;
      },
      catch: policyFailure,
    });

    const savePolicy = (next: {
      readonly pin: string;
      readonly salt: string;
      readonly revision: number;
      readonly profiles: KidsPolicy["profiles"];
    }) =>
      Effect.try({
        try: () => {
          const saved = db()
            .prepare("UPDATE kids_policy SET value = ? WHERE id = 1")
            .run(JSON.stringify(next));

          if (saved.changes !== 1) throw policyFailure();
        },
        catch: policyFailure,
      });

    const pinRequired = () =>
      new Failed({
        error: { kind: "invalid-input", detail: t("Kids policy: enter the correct PIN.") },
      });

    const checkPin = (policy: Effect.Success<typeof readPolicy>, pin?: string) =>
      Effect.try({
        try: () => {
          if (!policy.pin) return;

          if (!pin || !/^[0-9]{4,12}$/.test(pin)) throw pinRequired();
          const hash = scryptSync(pin, policy.salt, 32);
          const saved = Buffer.from(policy.pin, "hex");

          if (saved.length !== hash.length || !timingSafeEqual(saved, hash)) throw pinRequired();
        },
        catch: pinRequired,
      });

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
          Collections.layer,
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
        const collections = Context.get(context, Collections);

        const watches = [
          Stream.runForEach(collections.profileChanges, (owner) =>
            PubSub.publish(events, { kind: "collections", owner }),
          ),
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
          const policy = yield* readPolicy;
          const owner = { ...active };
          const kids = policy.profiles.find((row) => row.id === owner.id);
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
                          Context.add(
                            Context.add(handle.context, AdmittedKids, {
                              approved: kids?.approved ?? null,
                            }),
                            ViewingErasure,
                            erasure,
                          ),
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
            current: Effect.gen(function* () {
              if (!isActive(owner))
                return yield* refused(t("Viewing profile changed; retry this request."));
              const now = yield* readPolicy;

              if (
                JSON.stringify(now.profiles.find((row) => row.id === owner.id)) !==
                JSON.stringify(kids)
              )
                return yield* policyFailure();
            }),
            approved: kids?.approved ?? null,
            run,
            services: {
              viewing: Context.get(handle.context, ViewingRecord),
              watchlist: Context.get(handle.context, Watchlist),
              lists: Context.get(handle.context, CustomLists),
              collections: Context.get(handle.context, Collections),
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
        // before this completes. Failure keeps admissions closed for the existing retry path.
        // Failed in the error channel keeps its advice; a thrown callback becomes Failed.
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
      // Each acquisition returns one consumer stream, retained until its caller scope closes.
      changes: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
      list: Effect.gen(function* () {
        const policy = yield* readPolicy;

        return (yield* storage.list).map((row) => ({
          ...row,
          kids: policy.profiles.some((kids) => kids.id === row.id),
        }));
      }),
      visibility: Effect.gen(function* () {
        const policy = yield* readPolicy;
        const owner = { ...active };
        const kids = policy.profiles.find((row) => row.id === owner.id);

        return {
          owner,
          kids: kids !== undefined,
          allows: (approval: KidsApproval) => allowsApproval(kids?.approved ?? null, approval),
          current: Effect.gen(function* () {
            if (
              !isActive(owner) ||
              JSON.stringify((yield* readPolicy).profiles.find((row) => row.id === owner.id)) !==
                JSON.stringify(kids)
            )
              return yield* policyFailure();
          }),
        };
      }),
      policy: (expected: ActiveProfile, pin?: string) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            yield* expectedOwner(expected);
            const policy = yield* readPolicy;
            yield* checkPin(policy, pin);

            return { protected: policy.pin !== "", profiles: policy.profiles } satisfies KidsPolicy;
          }),
        ),
      setPolicy: (input: {
        readonly current: ActiveProfile;
        readonly pin?: string;
        readonly newPin?: string;
        readonly profiles: KidsPolicy["profiles"];
      }) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            yield* expectedOwner(input.current);
            const policy = yield* readPolicy;
            yield* checkPin(policy, input.pin);

            if (
              (!policy.pin && !input.newPin) ||
              (input.newPin !== undefined && !/^[0-9]{4,12}$/.test(input.newPin))
            )
              return yield* pinRequired();
            const rows = yield* storage.list;

            if (
              new Set(input.profiles.map((row) => row.id)).size !== input.profiles.length ||
              input.profiles.some(
                (row) =>
                  row.id === DEFAULT_PROFILE_ID || !rows.some((profile) => profile.id === row.id),
              )
            )
              return yield* refused(t("This viewing profile is unavailable or being deleted."));

            // Policy changes affect inactive profiles only: active playback must first leave through the lifecycle cleanup.
            if (
              input.profiles.some((row) => row.id === active.id) ||
              policy.profiles.some((row) => row.id === active.id)
            )
              return yield* refused(t("Viewing profile changed; retry this request."));
            const deleting = new Set(rows.filter((row) => row.deleting).map((row) => row.id));

            const profiles = [
              ...input.profiles.filter((row) => !deleting.has(row.id)),
              ...policy.profiles.filter((row) => deleting.has(row.id)),
            ];

            const salt = input.newPin ? randomUUID() : policy.salt;

            const next = {
              pin: input.newPin ? scryptSync(input.newPin, salt, 32).toString("hex") : policy.pin,
              salt,
              revision: policy.revision + 1,
              profiles,
            };

            yield* savePolicy(next);

            return { protected: true, profiles } satisfies KidsPolicy;
          }),
        ),
      active: activeRead,
      create: (name: string, expected?: ActiveProfile, pin?: string) =>
        one.withPermits(1)(
          Effect.andThen(
            Effect.andThen(
              expectedOwner(expected),
              Effect.flatMap(readPolicy, (policy) => checkPin(policy, pin)),
            ),
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
      switch: (id: string, expected?: ActiveProfile, pin?: string) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            // Retrying the same durably selected owner also retries its unfinished configuration.
            yield* expectedOwner(expected);

            const policy = yield* readPolicy;

            if (
              policy.profiles.some((row) => row.id === active.id) &&
              !policy.profiles.some((row) => row.id === id)
            )
              yield* checkPin(policy, pin);

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
      remove: (id: string, expected?: ActiveProfile, pin?: string) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            yield* expectedOwner(expected);
            const policy = yield* readPolicy;
            yield* checkPin(policy, pin);
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

            // Keep the tombstone retryable if its policy cleanup cannot be saved.
            if (policy.profiles.some((row) => row.id === id))
              yield* savePolicy({
                ...policy,
                revision: policy.revision + 1,
                profiles: policy.profiles.filter((row) => row.id !== id),
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
                Effect.andThen(
                  row.id === DEFAULT_PROFILE_ID && defaultErase
                    ? defaultErase
                    : Context.get(handle.context, ViewingRecord).erase(account),
                  Context.get(handle.context, CollectionsStore).erase(account),
                ),
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
          changes: Effect.flatMap(ready, (profiles) => profiles.changes).pipe(Effect.orDie),
          list: Effect.flatMap(ready, (profiles) => profiles.list),
          active: Effect.flatMap(ready, (profiles) => profiles.active),
          admit: Effect.flatMap(ready, (profiles) => profiles.admit),
          admitFor: (owner?: ActiveProfile) =>
            Effect.flatMap(ready, (profiles) => profiles.admitFor(owner)),
          visibility: Effect.flatMap(ready, (profiles) => profiles.visibility),
          policy: (expected: ActiveProfile, pin?: string) =>
            Effect.flatMap(ready, (profiles) => profiles.policy(expected, pin)),
          setPolicy: (input: Parameters<ProfileSessions["Service"]["setPolicy"]>[0]) =>
            Effect.flatMap(ready, (profiles) => profiles.setPolicy(input)),
          create: (name: string, expected?: ActiveProfile, pin?: string) =>
            Effect.flatMap(ready, (profiles) => profiles.create(name, expected, pin)),
          switch: (id: string, expected?: ActiveProfile, pin?: string) =>
            Effect.flatMap(ready, (profiles) => profiles.switch(id, expected, pin)),
          remove: (id: string, expected?: ActiveProfile, pin?: string) =>
            Effect.flatMap(ready, (profiles) => profiles.remove(id, expected, pin)),
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

/** The current viewer as publications filter for them: who, whether kids, and what they may see. */
export type Viewer = Effect.Success<ProfileSessions["Service"]["visibility"]>;
