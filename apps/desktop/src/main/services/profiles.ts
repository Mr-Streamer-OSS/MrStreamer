import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ActiveProfile } from "@mrstreamer/contracts/profiles";
import { ViewingStore } from "@mrstreamer/core/viewing/service";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import { defined } from "@mrstreamer/core/defined";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Semaphore from "effect/Semaphore";
import { profileStorage } from "../platform/profile-store.ts";
import { WatchlistStore } from "../platform/watchlist-store.ts";
import { CustomListStore } from "../platform/custom-lists-store.ts";
import { Settings, type InstallationConsent } from "./preferences.ts";
import { Subscriptions } from "./subscription.ts";
import { DEFAULT_PROFILE_ID } from "@mrstreamer/contracts/profiles";
import type { UsageObservers } from "../analytics/observers.ts";
import * as Layer from "effect/Layer";
import { Database, databaseLayer } from "../platform/database.ts";
import { profileDirectory } from "../platform/profile-store.ts";
import { observedViewingStoreLayer } from "../platform/viewing-store.ts";
import { watchlistStoreLayer } from "../platform/watchlist-store.ts";
import { customListStoreLayer } from "../platform/custom-lists-store.ts";

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

/** The complete personal service environment an admitted operation may use. */
type PersonalServices = ViewingStore | WatchlistStore | CustomListStore | Settings;

interface ProfileAdmission {
  readonly owner: ActiveProfile;
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
  usage,
  consent,
}: {
  readonly dataDir: string;
  readonly consent?: InstallationConsent;
  readonly stopInteractive?: () => Effect.Effect<void, Failed>;
  readonly usage?: UsageObservers;
}) {
  return Effect.gen(function* () {
    const storage = yield* profileStorage;
    const subscriptions = yield* Subscriptions;
    const one = yield* Semaphore.make(1);
    let active = yield* storage.active;

    const handles = new Map<
      string,
      {
        readonly context: Context.Context<PersonalServices>;
        readonly dispose: () => Promise<void>;
        readonly one: Semaphore.Semaphore;
        closed: boolean;
        epoch: number;
      }
    >();

    const refused = (detail: string) => new Failed({ error: { kind: "unexpected", detail } });

    const existing = (id: string) =>
      Effect.flatMap(storage.list, (rows) => {
        const found = rows.find((row) => row.id === id);

        return found && !found.deleting
          ? Effect.succeed(found)
          : Effect.fail(refused("This viewing profile is unavailable or being deleted."));
      });

    const opened = (id: string) =>
      Effect.gen(function* () {
        const retained = handles.get(id);

        if (retained) {
          if (retained.closed) return yield* refused("This viewing profile is being deleted.");

          return retained;
        }

        yield* existing(id);

        if (id !== DEFAULT_PROFILE_ID && !consent)
          return yield* refused("Profile switching requires the installation consent owner.");

        const runtime = ManagedRuntime.make(
          Layer.merge(
            personalStoresLayer({ dataDir, profileId: id, ...defined({ usage }) }),
            (consent
              ? Settings.profileLayer(dataDir, id, consent, usage)
              : Settings.layer(dataDir, usage)
            ).pipe(Layer.provide(Layer.succeed(Subscriptions, subscriptions))),
          ),
        );

        const context = yield* Effect.tryPromise({
          try: () => runtime.context(),
          catch: failedWith,
        });

        const handle = {
          context,
          dispose: () => runtime.dispose(),
          one: yield* Semaphore.make(1),
          closed: false,
          epoch: 0,
        };

        handles.set(id, handle);
        // A closed/unreadable database must fail admission, never appear as an empty profile.
        yield* Context.get(context, CustomListStore).lists;

        return handle;
      });

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        for (const handle of handles.values()) handle.closed = true;

        for (const handle of handles.values()) await handle.dispose();
      }),
    );

    return {
      list: storage.list,
      active: Effect.sync(() => ({ ...active })),
      create: (name: string) =>
        one.withPermits(1)(
          Effect.suspend(() => {
            const trimmed = name.trim();

            return trimmed.length > 0 && trimmed.length <= 80
              ? storage.create(randomUUID(), trimmed)
              : Effect.fail(
                  new Failed({
                    error: {
                      kind: "invalid-input",
                      detail: "A profile name must contain 1 to 80 characters.",
                    },
                  }),
                );
          }),
        ),
      admit: one.withPermits(1)(
        Effect.gen(function* () {
          const owner = { ...active };
          const handle = yield* opened(owner.id);
          const epoch = handle.epoch;

          const run: ProfileAdmission["run"] = (work) =>
            handle.one.withPermits(1)(
              Effect.gen(function* () {
                if (handle.closed || handle.epoch !== epoch)
                  return yield* refused("This profile admission has ended; retry the operation.");

                return yield* Effect.provideContext(work, handle.context);
              }),
            );

          return { owner, run } satisfies ProfileAdmission;
        }),
      ),
      switch: (id: string) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            if (id === active.id) return { ...active };

            if (!stopInteractive)
              return yield* refused(
                "Profile switching is not enabled until interactive isolation is ready.",
              );
            yield* opened(id);
            yield* stopInteractive();
            // Publish only after the durable selection commits; a failed save leaves the old owner.
            active = yield* storage.select(id);

            return { ...active };
          }),
        ),
      remove: (id: string) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            // Persist the tombstone before waiting for pending operations or touching files. A failed
            // close keeps both the directory and registry row for retry, including after restart.
            yield* storage.deleting(id);
            const handle = handles.get(id);

            if (handle) {
              handle.closed = true;
              yield* handle.one.withPermits(1)(
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
      eraseSource: (account: string) =>
        one.withPermits(1)(
          Effect.gen(function* () {
            const rows = yield* storage.list;

            // Separate owner databases cannot commit atomically together. Completed erasures remain
            // erased if a later owner fails. Return that failure; retrying erases the entire set again.
            for (const row of rows) {
              if (row.deleting)
                return yield* refused(
                  "Finish deleting the pending profile before erasing a source.",
                );
              const handle = yield* opened(row.id);
              handle.epoch++;
              yield* handle.one.withPermits(1)(
                Context.get(handle.context, ViewingStore).erase(account),
              );
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
    Layer.effect(ProfileSessions, makeProfiles(options));
}
