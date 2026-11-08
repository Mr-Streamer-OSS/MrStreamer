import { Failed } from "@mrstreamer/core/failure";
import type { IpcMainInvokeEvent } from "electron";
import type { Json } from "@mrstreamer/contracts/json";
import type { Result } from "@mrstreamer/contracts/errors";
import { registerIpc, type IpcHandlers } from "../src/main/ipc.ts";
import { subscriptionHandlers } from "../src/main/handlers/subscriptions.ts";

const ipcBoundary = vi.hoisted(
  () =>
    new Map<
      string,
      (event: IpcMainInvokeEvent, input: Json | undefined) => Promise<Result<unknown>>
    >(),
);

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      method: string,
      handler: (event: IpcMainInvokeEvent, input: Json | undefined) => Promise<Result<unknown>>,
    ) => ipcBoundary.set(method, handler),
  },
}));

import {
  defaultPreferences,
  defaultSubscriptionPreferences,
} from "@mrstreamer/contracts/preferences";
import type { Connection, ReceiverAdapter, AdapterEvent } from "../src/main/receivers/adapter.ts";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { playlistGroupId } from "@mrstreamer/core/playlist/import";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROFILE_ID } from "@mrstreamer/contracts/profiles";
import {
  ViewingRecord,
  ViewingAccount,
  ViewingChannels,
  ViewingSeries,
  ViewingErasure,
  LegacyViewing,
} from "@mrstreamer/core/viewing/service";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import type { OutputStatus } from "@mrstreamer/contracts/output";
import * as Context from "effect/Context";
import { ViewingStore } from "@mrstreamer/core/viewing/service";
import {
  AdmittedViewing,
  personalStoresLayer,
  ProfileSessions,
} from "../src/main/services/profiles.ts";
import { WatchlistStore } from "../src/main/platform/watchlist-store.ts";
import { CustomListStore } from "../src/main/platform/custom-lists-store.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Output } from "../src/main/services/output.ts";
import { Recordings } from "../src/main/services/recordings.ts";
import { startFakeTmdb } from "./fake-tmdb.ts";
import { VerifiedFiles } from "../src/main/platform/verified-files.ts";
import { copyProgress } from "../src/main/platform/profile-copy-progress.ts";
import { Database } from "../src/main/platform/database.ts";
import { Profiles, profileDirectory } from "../src/main/platform/profile-store.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { analyticsFixture } from "./e2e/analytics-fixture.ts";
import { CustomLists } from "../src/main/services/custom-lists.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Settings, AdmittedSettings } from "../src/main/services/preferences.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { Watchlist } from "../src/main/services/watchlist.ts";
import {
  demoLogin,
  fakeProvider,
  promised,
  runtimeFor,
  tempDir,
  testConfig,
  testSecrets,
  userAgent,
} from "./support.ts";

/** The app started on `dataDir`, with the services a viewer's personal state goes through. */
async function started(dataDir: string) {
  const runtime = runtimeFor(mainLayer(testConfig(dataDir)));

  return {
    dispose: () => runtime.dispose(),
    profiles: await promised(runtime, Profiles),
    viewing: await promised(runtime, ViewingRecord),
    watchlist: await promised(runtime, Watchlist),
    lists: await promised(runtime, CustomLists),
    settings: await promised(runtime, Settings),
    roster: await promised(runtime, Roster),
    library: await promised(runtime, Library),
    onDemand: await promised(runtime, OnDemand),
  };
}

type App = Awaited<ReturnType<typeof started>>;

/** Everything personal the window shows: what must come through an upgrade unchanged. */
async function personal(app: App) {
  return {
    viewing: await app.viewing.state(),
    watchlist: await app.watchlist.list({ sort: "saved", offset: 0, limit: 100 }),
    lists: await app.lists.lists(),
    preferences: await app.settings.get(),
  };
}

/** Opens the database as another copy of the app would. */
function onDisk<A>(dataDir: string, use: (db: DatabaseSync) => A): A {
  const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));

  try {
    return use(db);
  } finally {
    db.close();
  }
}

const DEFAULT = { id: DEFAULT_PROFILE_ID, revision: 1 };

describe("the Default viewing profile", { timeout: 60_000 }, () => {
  it("keeps what an earlier release saved under Default, across the upgrade and restarts", async () => {
    const dataDir = await tempDir();
    const provider = await fakeProvider();
    const earlier = await started(dataDir);
    const subscriptionId = (await earlier.roster.add(demoLogin(provider))).id;
    await earlier.library.refresh(subscriptionId);
    await earlier.onDemand.refresh(subscriptionId);
    const channel = { subscriptionId, id: "2014" };
    await earlier.viewing.setFavourite(randomUUID(), channel, true);
    await earlier.viewing.recordWatch(randomUUID(), { subscriptionId, id: "2015" });
    await earlier.viewing.recordProgress(
      randomUUID(),
      { kind: "movie", subscriptionId, id: "90001" },
      600,
      6000,
      Date.now(),
    );
    await earlier.watchlist.save("movie", { subscriptionId, id: "90002" });
    await earlier.lists.create({ id: randomUUID(), name: "Sport", channel });
    await earlier.settings.update({ volume: 0.3, audioLanguage: "fr" });
    const saved = await personal(earlier);
    await earlier.profiles.active();
    await earlier.dispose();
    // As every release before profiles leaves the database: without the profile registry.
    onDisk(dataDir, (db) => db.exec("drop table active_profile; drop table profiles"));

    const upgraded = await started(dataDir);

    expect(await upgraded.profiles.active()).toEqual(DEFAULT);
    expect(await personal(upgraded)).toEqual(saved);
    expect(saved.viewing.favourites).toEqual([channel]);
    expect(saved.viewing.continueWatching).toHaveLength(1);
    expect(saved.watchlist.entries).toHaveLength(1);
    expect(saved.lists.map(({ name }) => name)).toEqual(["Sport"]);

    await upgraded.dispose();
    const restarted = await started(dataDir);

    expect(await restarted.profiles.active()).toEqual(DEFAULT);
    expect(await personal(restarted)).toEqual(saved);
  });

  it("answers no profile while its registry can't be written, and imports the legacy lists once", async () => {
    const dataDir = await tempDir();
    const provider = await fakeProvider();

    // A subscription and the lists preferences.json kept before the viewing record and profiles.
    const login = runtimeFor(
      Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
    );

    const subscriptionId = (await (await promised(login, Subscriptions)).add(demoLogin(provider)))
      .id;

    await login.dispose();

    const legacy = JSON.stringify({
      volume: 0.4,
      muted: false,
      lastChannelId: null,
      lastCategoryId: null,
      favouriteChannelIds: ["2014", "2015"],
    });

    await writeFile(join(dataDir, "preferences.json"), legacy);

    // Another copy of the app holds the write lock for all of the upgraded start.
    const holder = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    let refused: App;

    try {
      holder.exec("pragma journal_mode = wal; begin immediate");
      refused = await started(dataDir);

      await expect(refused.profiles.active()).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
    } finally {
      if (holder.isTransaction) holder.exec("rollback");
      holder.close();
    }

    expect(await refused.profiles.active()).toEqual(DEFAULT);
    await refused.dispose();
    const restarted = await started(dataDir);
    const imported = await restarted.viewing.state();

    expect(await restarted.profiles.active()).toEqual(DEFAULT);
    expect(imported.favourites).toEqual([
      { subscriptionId, id: "2014" },
      { subscriptionId, id: "2015" },
    ]);

    // The lists back in the file, as after a crash before it was cleaned, aren't imported again.
    await restarted.dispose();
    await writeFile(join(dataDir, "preferences.json"), legacy);
    const again = await started(dataDir);

    expect(await again.viewing.state()).toEqual(imported);
  });

  it("answers no profile when a later release left another one active, and keeps it so", async () => {
    const dataDir = await tempDir();
    const initial = await started(dataDir);
    await initial.profiles.active();
    await initial.dispose();
    // What a release with more profiles leaves after its viewer chose another.
    onDisk(dataDir, (db) =>
      db.exec(`
        insert into profiles (id, created_at) values ('later', 0);
        update active_profile set profile_id = 'later', revision = 7;
      `),
    );

    for (let start = 0; start < 2; start++) {
      const app = await started(dataDir);

      await expect(app.profiles.active()).rejects.toMatchObject({
        error: { kind: "unexpected" },
      });
      await app.dispose();
    }
  });
});

describe("admitted personal stores", () => {
  it("keeps identical source, content, list and command ids private through delayed writes and restart", async () => {
    const dataDir = await tempDir();

    const open = async (id: string) => {
      const runtime = runtimeFor(personalStoresLayer({ dataDir, profileId: id }));

      return {
        close: () => runtime.dispose(),
        viewing: await promised(runtime, ViewingStore),
        watchlist: await promised(runtime, WatchlistStore),
        lists: await promised(runtime, CustomListStore),
      };
    };

    const a = await open("default");
    const b = await open("viewer-b");

    const commit = (viewer: typeof a, channelId: string) =>
      viewer.viewing.commit({
        accounts: ["source"],
        commandId: "same-command",
        at: 1,
        decide: () => [{ account: "source", event: { type: "favourite-added", channelId } }],
      });

    await commit(b, "b-channel");
    // The retained handle is A's admitted owner, even after the caller starts using B.
    await commit(a, "same-content");
    expect((await a.viewing.read(["source"])).favourites.map(({ id }) => id)).toEqual([
      "same-content",
    ]);
    expect((await b.viewing.read(["source"])).favourites.map(({ id }) => id)).toEqual([
      "b-channel",
    ]);

    for (const viewer of [a, b]) {
      expect((await viewer.viewing.read(["source"])).favourites).toHaveLength(1);
      await viewer.lists.create({ id: "same-list", name: "Private", first: null, at: 1 });
      await viewer.watchlist.save({
        listed: [
          {
            account: "source",
            facts: {
              kind: "movie",
              tmdbId: "123",
              versionIds: ["same-content"],
              name: "Film",
              year: null,
              adult: false,
            },
          },
        ],
        at: 1,
        stands: () => true,
      });
      await viewer.viewing.commit({
        accounts: ["source"],
        commandId: "same-progress-command",
        at: Date.now(),
        decide: () => [
          {
            account: "source",
            event: {
              type: "title-progress",
              title: { kind: "movie", id: "same-content" },
              position: viewer === a ? 120 : 240,
              duration: 1000,
              since: Date.now(),
            },
          },
        ],
      });
    }

    expect(
      (await a.viewing.read(["source"])).continueWatching.map(({ progress }) => progress.position),
    ).toEqual([120]);
    expect(
      (await b.viewing.read(["source"])).continueWatching.map(({ progress }) => progress.position),
    ).toEqual([240]);
    await a.lists.rename("same-list", "A only");
    expect((await b.lists.lists()).map(({ name }) => name)).toEqual(["Private"]);
    await a.viewing.erase("source");
    expect((await a.viewing.read(["source"])).favourites).toEqual([]);
    expect(await a.watchlist.entries(["source"])).toEqual([]);
    expect(await b.watchlist.entries(["source"])).toHaveLength(1);
    expect((await b.viewing.read(["source"])).favourites).toHaveLength(1);
    await a.close();
    await b.close();
    const restored = await open("viewer-b");
    expect((await restored.viewing.read(["source"])).favourites).toHaveLength(1);
    expect((await restored.lists.lists()).map(({ name }) => name)).toEqual(["Private"]);
  });

  it("keeps added-subscription preferences with their admitted viewer", async () => {
    const dataDir = await tempDir();
    const provider = await fakeProvider();
    const addedProvider = await fakeProvider({ second: true });

    const household = runtimeFor(
      Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
    );

    const subscriptions = await promised(household, Subscriptions);
    await subscriptions.add(demoLogin(provider));
    const second = await subscriptions.add(demoLogin(addedProvider));
    const shared = Layer.succeed(Subscriptions, await household.runPromise(Subscriptions));

    const installation = await promised(
      runtimeFor(Settings.layer(dataDir).pipe(Layer.provide(shared))),
      Settings,
    );

    const consent = {
      read: Effect.promise(async () => (await installation.get()).analyticsEnabled ?? true),
      write: (enabled: boolean) =>
        Effect.asVoid(Effect.promise(() => installation.update({ analyticsEnabled: enabled }))),
    };

    const open = async (id: string) => {
      const runtime = runtimeFor(
        Settings.profileLayer(dataDir, id, consent).pipe(Layer.provide(shared)),
      );

      return { close: () => runtime.dispose(), settings: await promised(runtime, Settings) };
    };

    const a = await open("default");
    const b = await open("viewer-b");
    await a.settings.updateSubscription(second.id, { lastChannelId: "A" });
    expect((await b.settings.ofSubscription(second.id)).lastChannelId).toBeNull();
    await b.settings.updateSubscription(second.id, { lastChannelId: "B" });
    await a.settings.update({ volume: 0.3 });
    expect((await b.settings.get()).volume).not.toBe(0.3);
    expect((await a.settings.ofSubscription(second.id)).lastChannelId).toBe("A");
    await b.close();
    const restarted = await open("viewer-b");
    expect((await restarted.settings.ofSubscription(second.id)).lastChannelId).toBe("B");
  });
});

describe("profile lifecycle before UI enablement", () => {
  it("retains admitted owners across switch, erases all owners retryably, and deletes only inactive personal data", async () => {
    const dataDir = await tempDir();
    let stops = 0;

    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(dataDir),
        profiles: {
          consent: { read: Effect.succeed(true), write: () => Effect.void },
          stopInteractive: () =>
            Effect.sync(() => {
              stops++;
            }),
        },
      }),
    );

    const profiles = await promised(runtime, ProfileSessions);
    const a = await profiles.admit();
    const b = await profiles.create("Viewer B");
    await profiles.switch(b.id);
    expect(stops).toBe(1);
    const admittedB = await profiles.admit();

    const save = (channelId: string) =>
      Effect.flatMap(ViewingStore, (store) =>
        store.commit({
          accounts: ["source"],
          commandId: "same-id",
          at: Date.now(),
          decide: () => [{ account: "source", event: { type: "favourite-added", channelId } }],
        }),
      );

    await runtime.runPromise(admittedB.run(save("B")));
    await runtime.runPromise(a.run(save("A")));

    const favourites = Effect.flatMap(ViewingStore, (store) =>
      Effect.map(store.read(["source"]), (state) => state.favourites.map(({ id }) => id)),
    );

    expect(await runtime.runPromise(a.run(favourites))).toEqual(["A"]);
    expect(await runtime.runPromise(admittedB.run(favourites))).toEqual(["B"]);
    // A held second database demonstrates the cross-file failure boundary: Default's erase
    // commits, B's fails, the caller sees failure, and the same operation can be retried.
    const lock = new DatabaseSync(join(profileDirectory(dataDir, b.id), "mrstreamer.db"));

    try {
      lock.exec("begin immediate");
      await expect(profiles.eraseSource("source")).rejects.toBeDefined();
    } finally {
      lock.exec("rollback");
      lock.close();
    }

    // Erasure no longer invalidates unrelated work through this admission. A raw durable
    // read sees the committed erasure; named viewing callbacks carry the source guard.
    expect(await runtime.runPromise(a.run(favourites))).toEqual([]);
    expect(await runtime.runPromise((await profiles.admit()).run(favourites))).toEqual(["B"]);
    await profiles.eraseSource("source");
    expect(await runtime.runPromise((await profiles.admit()).run(favourites))).toEqual([]);
    await expect(profiles.remove(b.id)).rejects.toBeDefined();
    await profiles.switch("default");
    // Household files sit outside every removable personal directory.
    await writeFile(join(dataDir, "recordings.json"), "household recordings");
    await profiles.remove(b.id);
    await expect(
      runtime.runPromise(
        admittedB.run(Effect.flatMap(Settings, (settings) => settings.update({ volume: 0.7 }))),
      ),
    ).rejects.toBeDefined();
    expect((await profiles.list()).map(({ id }) => id)).toEqual(["default"]);
    expect(await readFile(join(dataDir, "recordings.json"), "utf8")).toBe("household recordings");
    await expect(profiles.remove("default")).rejects.toBeDefined();
    await expect(profiles.switch(b.id)).rejects.toBeDefined();
  });
});

const { start: startAnalytics } = analyticsFixture({
  app_version: "0.0.24",
  build_channel: "nightly",
  update_channel: "stable",
  os: "linux",
  arch: "x64",
  distribution: "direct",
});

it("profile consent edits use the installation Analytics owner across switch and restart", async () => {
  const dataDir = await tempDir();
  let analytics = await startAnalytics({ dataDir, transport: null });

  const consent = {
    read: Effect.promise(async () => (await analytics.owner.settings()).enabled),
    write: (enabled: boolean) =>
      Effect.asVoid(Effect.promise(() => analytics.owner.configure(enabled))),
  };

  const open = async () => {
    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(dataDir),
        profiles: { consent, stopInteractive: () => Effect.void },
      }),
    );

    return { runtime, profiles: await promised(runtime, ProfileSessions) };
  };

  const app = await open();
  const b = await app.profiles.create("B");
  await app.profiles.switch(b.id);

  const read = Effect.flatMap(Settings, (settings) =>
    Effect.map(settings.get, (preferences) => preferences.analyticsEnabled),
  );

  await app.runtime.runPromise(
    (await app.profiles.admit()).run(
      Effect.flatMap(Settings, (settings) => settings.update({ analyticsEnabled: false })),
    ),
  );
  expect((await analytics.owner.settings()).enabled).toBe(false);
  await app.profiles.switch("default");
  expect(await app.runtime.runPromise((await app.profiles.admit()).run(read))).toBe(false);
  await app.runtime.dispose();
  await analytics.owner.close();
  analytics = await startAnalytics({ dataDir, transport: null });
  const restarted = await open();
  await restarted.profiles.switch(b.id);
  expect(await restarted.runtime.runPromise((await restarted.profiles.admit()).run(read))).toBe(
    false,
  );
  expect((await analytics.owner.settings()).enabled).toBe(false);
});

it("copy progress callbacks keep the owner admitted before file reads and later switches", async () => {
  const db = new DatabaseSync(":memory:");
  onTestFinished(() => db.close());
  let active = "default";

  const progress = await Effect.runPromise(
    copyProgress.pipe(
      Effect.provideService(Database, { db }),
      Effect.provideService(Profiles, { active: Effect.sync(() => ({ id: active, revision: 1 })) }),
    ),
  );

  const a = await Effect.runPromise(progress.admit);
  active = "B";
  const b = await Effect.runPromise(progress.admit);
  await Effect.runPromise(b.write("recording", "same-copy", 240, 1000));
  await Effect.runPromise(a.write("recording", "same-copy", 120, 1000));
  expect(await Effect.runPromise(b.read("recording", "same-copy", null))).toEqual({
    position: 240,
    duration: 1000,
  });
  expect(await Effect.runPromise(a.read("recording", "same-copy", null))).toEqual({
    position: 120,
    duration: 1000,
  });
});

it("refuses an old catalogue read after held file facts cross a profile switch and recovers for the current owner", async () => {
  const dataDir = await tempDir();
  const remote = await startFakeTmdb();
  onTestFinished(() => remote.close());
  const config = { ...testConfig(dataDir), tmdbApi: remote.url };

  const app = runtimeFor(
    mainLayer({
      ...config,
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const provider = await fakeProvider();
  const roster = await promised(app, Roster);
  const source = await roster.add(demoLogin(provider));
  const catalogue = await promised(app, OnDemand);
  await catalogue.refresh(source.id);
  const profiles = await promised(app, ProfileSessions);
  const a = await profiles.admit();
  const b = await profiles.create("B");
  const context = await app.context();
  const facts = Context.get(context, VerifiedFiles);
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  let hold = false;

  const isolated = runtimeFor(
    OnDemand.layer({
      dataDir,
      worker: config.catalogueWorker,
      tmdbKey: null,
      tmdbApi: remote.url,
      userAgent,
      region: config.region,
    }).pipe(
      Layer.provide(
        Layer.succeedContext(
          Context.add(context, VerifiedFiles, {
            ...facts,
            read: (account, stamp) =>
              Effect.gen(function* () {
                if (hold) {
                  hold = false;
                  arrived.resolve();
                  yield* Effect.promise(() => release.promise);
                }

                return yield* facts.read(account, stamp);
              }),
          }),
        ),
      ),
    ),
  );

  const service = await isolated.runPromise(OnDemand);
  const query = { kind: "movie" as const, id: "all" as const, offset: 0, limit: 20, filters: {} };
  hold = true;
  const pending = app.runPromise(a.run(service.collection(query)));
  const refused = expect(pending).rejects.toMatchObject({ error: { kind: "unexpected" } });
  await arrived.promise;
  await profiles.switch(b.id);
  const admittedB = await profiles.admit();
  await app.runPromise(
    admittedB.run(
      Effect.flatMap(Settings, (settings) => settings.update({ tmdbKey: "fixture-profile-b-key" })),
    ),
  );
  await app.runPromise(admittedB.run(service.reconfigure));
  release.resolve();
  await refused;
  const current = await app.runPromise(admittedB.run(service.collection(query)));
  expect(current.total).toBeGreaterThan(0);
});

it("household IPC background catalogue work retains admitted settings and refuses a switched owner after file reads", async () => {
  const dataDir = await tempDir();

  const app = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const roster = await app.runPromise(Roster);
  const subscriptions = await app.runPromise(Subscriptions);
  const settings = await app.runPromise(Settings);
  const profiles = await promised(app, ProfileSessions);
  const sessions = await app.runPromise(ProfileSessions);
  const source = await app.runPromise(roster.add(demoLogin(await fakeProvider())));
  const a = await profiles.create("A");
  await profiles.switch(a.id);
  const admitted = await profiles.admit();
  await app.runPromise(
    admitted.run(admitted.services.settings.update({ titleLanguage: "fr", adultTitles: true })),
  );
  const context = await app.context();
  const facts = Context.get(context, VerifiedFiles);
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  let hold = true;

  const isolated = runtimeFor(
    OnDemand.layer({
      dataDir,
      worker: testConfig(dataDir).catalogueWorker,
      tmdbKey: null,
      userAgent,
      region: testConfig(dataDir).region,
    }).pipe(
      Layer.provide(
        Layer.succeedContext(
          Context.add(context, VerifiedFiles, {
            ...facts,
            read: (account, stamp) =>
              Effect.gen(function* () {
                if (hold) {
                  hold = false;
                  arrived.resolve();
                  yield* Effect.promise(() => release.promise);
                }

                return yield* facts.read(account, stamp);
              }),
          }),
        ),
      ),
    ),
  );

  const catalogue = await isolated.runPromise(OnDemand);
  const scope = await app.runPromise(Scope.make());
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const done = Promise.withResolvers<Exit.Exit<unknown, Failed>>();

  const seen: {
    owner: string | null;
    language: string | undefined;
    adults: boolean | undefined;
  }[] = [];

  const handlers = subscriptionHandlers({ roster, subscriptions, settings });
  registerIpc(app.runPromiseExit, handlers as IpcHandlers, () => true, {
    admit: sessions.admitFor,
    handlers: () => ({
      "subscription.update": (input, frame) =>
        Effect.gen(function* () {
          const result = yield* handlers["subscription.update"](input, frame);
          yield* Effect.forkIn(
            Effect.gen(function* () {
              const captured = yield* Effect.serviceOption(AdmittedSettings);
              const personal = captured._tag === "Some" ? captured.value.settings : settings;
              const preferences = yield* personal.get;
              seen.push({
                owner: captured._tag === "Some" ? captured.value.owner.id : null,
                language: preferences.titleLanguage,
                adults: preferences.adultTitles,
              });

              const exit = yield* Effect.exit(
                catalogue.collection({
                  kind: "movie",
                  id: "all",
                  offset: 0,
                  limit: 20,
                  filters: {},
                }),
              );

              const retained = yield* personal.get;
              seen.push({
                owner: captured._tag === "Some" ? captured.value.owner.id : null,
                language: retained.titleLanguage,
                adults: retained.adultTitles,
              });
              done.resolve(exit);
            }),
            scope,
          );

          return result;
        }),
    }),
  });
  const frame = { processId: 1, routingId: 1 };
  const event = { sender: { mainFrame: frame }, senderFrame: frame } as IpcMainInvokeEvent;
  expect(
    (
      await ipcBoundary.get("subscription.update")!(event, {
        __profile: admitted.owner,
        input: { subscriptionId: source.id, name: "Renamed" },
      })
    ).ok,
  ).toBe(true);
  await arrived.promise;
  await profiles.switch(DEFAULT.id);
  release.resolve();
  const completed = await done.promise;
  expect.soft(seen).toEqual([
    { owner: a.id, language: "fr", adults: true },
    { owner: a.id, language: "fr", adults: true },
  ]);
  expect(Exit.isFailure(completed)).toBe(true);

  if (Exit.isFailure(completed))
    expect(Cause.squash(completed.cause)).toMatchObject({
      error: { kind: "unexpected", detail: "Viewing profile changed; retry this catalogue read." },
    });
}, 10_000);

it("keeps a failed post-selection configuration visible and retries it before admitting work", async () => {
  const dataDir = await tempDir();
  let refuse = false;

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      profiles: {
        consent: {
          read: Effect.sync(() => {
            if (refuse) throw new Error("fixture consent read refused");

            return true;
          }),
          write: () => Effect.void,
        },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const profiles = await promised(runtime, ProfileSessions);
  const b = await profiles.create("B");
  refuse = true;
  await expect(profiles.switch(b.id)).rejects.toMatchObject({
    error: { kind: "unexpected", detail: "fixture consent read refused" },
  });
  expect((await profiles.active()).id).toBe(b.id);
  await expect(profiles.admit()).rejects.toBeDefined();
  const selected = await profiles.active();
  refuse = false;
  await expect(profiles.switch(b.id, { id: "default", revision: 1 })).rejects.toBeDefined();
  expect(await profiles.switch(b.id, selected)).toEqual(selected);
  expect((await profiles.admit()).owner.id).toBe(b.id);
});

it("source removal cannot succeed on partial cross-profile erasure or revive an invalidated admission", async () => {
  const dataDir = await tempDir();

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const provider = await fakeProvider();
  const roster = await promised(runtime, Roster);
  const source = await roster.add(demoLogin(provider));
  const library = await promised(runtime, Library);
  await library.refresh(source.id);
  const profiles = await promised(runtime, ProfileSessions);
  const a = await profiles.admit();
  const channel = { subscriptionId: source.id, id: "2014" };
  await runtime.runPromise(a.run(a.services.viewing.setFavourite("same-command", channel, true)));
  const b = await profiles.create("B");
  await profiles.switch(b.id);
  const admittedB = await profiles.admit();
  await runtime.runPromise(
    admittedB.run(admittedB.services.viewing.setFavourite("same-command", channel, true)),
  );
  const lock = new DatabaseSync(join(profileDirectory(dataDir, b.id), "mrstreamer.db"));

  try {
    lock.exec("begin immediate");
    await expect(roster.remove(source.id, true)).rejects.toBeDefined();
  } finally {
    lock.exec("rollback");
    lock.close();
  }

  const subscriptions = await promised(runtime, Subscriptions);
  expect((await subscriptions.list()).map(({ id }) => id)).toContain(source.id);
  await expect(
    runtime.runPromise(a.run(a.services.viewing.recordWatch("late", channel))),
  ).rejects.toBeDefined();
  await expect(
    runtime.runPromise(admittedB.run(admittedB.services.viewing.recordWatch("late", channel))),
  ).rejects.toBeDefined();
  const currentB = await profiles.admit();
  expect(
    (await runtime.runPromise(currentB.run(currentB.services.viewing.state))).favourites,
  ).toEqual([channel]);
  await roster.remove(source.id, true);
  expect(await subscriptions.list()).toEqual([]);
  await profiles.switch("default");
  const currentA = await profiles.admit();
  expect(
    (await runtime.runPromise(currentA.run(currentA.services.viewing.state))).favourites,
  ).toEqual([]);
});

it("profile switching closes interactive playback and pending opens while a household recording keeps its id and stream", async () => {
  const dataDir = await tempDir();
  let stop: () => Effect.Effect<void> = () => Effect.void;

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => stop(),
      },
    }),
  );

  const playback = await promised(runtime, Playback);
  const raw = await runtime.runPromise(Playback);
  const output = await runtime.runPromise(Output);
  stop = () => Effect.andThen(raw.closeForProfile, output.disconnect);
  const provider = await fakeProvider({ live: true });
  const source = await (await promised(runtime, Roster)).add(demoLogin(provider));
  await (await promised(runtime, Library)).refresh(source.id);

  const tracks = provider.catalogue.channels.find(
    (channel) => channel.fixture === "h264-subtitles.mpegts",
  );

  if (!tracks) throw new Error("The fixture has no subtitle channel.");
  const channel = { subscriptionId: source.id, id: String(tracks.streamId) };
  const recordings = await promised(runtime, Recordings);
  const started = await recordings.start(channel, Date.now() + 60_000);

  if (started.kind !== "started") throw new Error("The household recording did not start.");

  try {
    const watching = await playback.open(channel, ["h264", "aac"]);
    const pendingTurn = await playback.begin();
    const asked = provider.streamRequests();
    const profiles = await promised(runtime, ProfileSessions);
    const b = await profiles.create("B");
    await profiles.switch(b.id);
    expect(await playback.playing(watching.sessionId)).toBeNull();
    await expect(
      playback.open(channel, ["h264", "aac"], { turn: pendingTurn }),
    ).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "Something else played in the meantime." },
    });
    const recording = (await recordings.list()).find(({ id }) => id === started.recording.id);
    expect(recording?.status.kind).toBe("recording");
    expect(provider.streamRequests()).toBe(asked);
    expect(provider.activeStreams()).toBe(1);
  } finally {
    await recordings.stop(started.recording.id);
  }
});

it.each(["success", "refusal"] as const)(
  "a late old-profile receiver picker %s cannot adopt or reset the new viewer's connection",
  async (outcome) => {
    const dataDir = await tempDir();
    const held = Promise.withResolvers<Connection | null>();
    const arrived = Promise.withResolvers<void>();
    const disconnected: string[] = [];

    const connection = (name: string): Connection => ({
      receiver: { id: "same-receiver", kind: "airplay", name },
      localAddress: null,
      decoders: ["h264", "aac"],
      volume: false,
      load: async () => {},
      play: async () => {},
      pause: async () => {},
      seek: async () => {},
      showSubtitles: async () => {},
      setVolume: async () => {},
      stop: async () => {},
      disconnect: async () => {
        disconnected.push(name);
      },
    });

    let hear: (event: AdapterEvent) => void = () => {};

    const adapter: ReceiverAdapter = {
      kind: "airplay",
      listen: (listener) => {
        hear = listener;
      },
      scan: (on) => {
        if (on)
          hear({
            type: "receivers",
            receivers: [{ id: "same-receiver", kind: "airplay", name: "TV" }],
          });
      },
      connect: async (request) => {
        if (request.kind === "picker") {
          arrived.resolve();

          return held.promise;
        }

        return connection("B connection");
      },
      close: async () => {
        held.resolve(null);
      },
    };

    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(dataDir),
        output: { adapters: [adapter] },
        profiles: {
          consent: { read: Effect.succeed(true), write: () => Effect.void },
          // Do not rely on cancellation for this contract: the external boundary can answer late.
          stopInteractive: () => Effect.void,
        },
      }),
    );

    const profiles = await promised(runtime, ProfileSessions);
    const output = await runtime.runPromise(Output);
    const a = await profiles.admit();
    await runtime.runPromise(a.run(output.scan(true)));

    const old = runtime.runPromise(
      a.run(output.pick(async () => ({ x: 0, y: 0, width: 1, height: 1 }), "A picker")),
    );

    const refused = expect(old).rejects.toMatchObject({ error: { kind: "unexpected" } });
    await arrived.promise;
    const b = await profiles.create("B");
    await profiles.switch(b.id);
    const admittedB = await profiles.admit();
    const connected = await runtime.runPromise(admittedB.run(output.connect("same-receiver")));
    expect(connected.owner).toEqual(admittedB.owner);

    if (outcome === "success") held.resolve(connection("A late connection"));
    else held.reject(new Error("fixture old picker refused"));
    await refused;
    const state = await runtime.runPromise(admittedB.run(output.status));
    expect(state.owner).toEqual(admittedB.owner);
    expect(state.output).toMatchObject({ kind: "receiver", receiver: { name: "B connection" } });
    expect(disconnected).not.toContain("B connection");

    if (outcome === "success") expect(disconnected).toContain("A late connection");
  },
);

it("refuses missing or stale desktop ownership after switching away and back", async () => {
  const dataDir = await tempDir();

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const profiles = await promised(runtime, ProfileSessions);
  expect((await profiles.admitFor()).owner).toEqual(DEFAULT);
  const b = await profiles.create("B");
  await profiles.switch(b.id);
  await expect(profiles.admitFor()).rejects.toMatchObject({ error: { kind: "unexpected" } });
  const again = await profiles.switch(DEFAULT_PROFILE_ID);
  await expect(profiles.admitFor(DEFAULT)).rejects.toMatchObject({ error: { kind: "unexpected" } });
  await expect(profiles.admitFor()).rejects.toMatchObject({ error: { kind: "unexpected" } });
  expect((await profiles.admitFor(again)).owner).toEqual(again);
});

it.each(["broken JSON", "invalid volume", "private syntax", "private schema"] as const)(
  "refuses unreadable private preferences without saving defaults over them: %s",
  async (example) => {
    const privateValue = `p${randomUUID().slice(0, 7)}`;

    const bytes = {
      "broken JSON": "{",
      "invalid volume": '{"volume":"unreadable"}',
      "private syntax": privateValue,
      "private schema": JSON.stringify({
        ...defaultPreferences,
        ...defaultSubscriptionPreferences,
        liveView: privateValue,
      }),
    }[example];

    const dataDir = await tempDir();
    const dir = profileDirectory(dataDir, "viewer-b");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "preferences.json");
    await writeFile(path, bytes);

    const runtime = runtimeFor(
      Settings.profileLayer(dataDir, "viewer-b", {
        read: Effect.succeed(true),
        write: () => Effect.void,
      }).pipe(
        Layer.provide(
          Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
        ),
      ),
    );

    const settings = await promised(runtime, Settings);
    await expect(settings.get()).rejects.toBeDefined();

    const detail = await settings.get().then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(detail).not.toBeNull();
    expect(String(detail)).not.toContain(privateValue);
    expect(JSON.stringify(detail)).not.toContain(privateValue);

    if (detail instanceof Error) expect(detail.cause).toBeUndefined();

    await expect(settings.update({ volume: 0.5 })).rejects.toBeDefined();
    expect(await readFile(path, "utf8")).toBe(bytes);
    await writeFile(
      path,
      JSON.stringify({ ...defaultPreferences, ...defaultSubscriptionPreferences, volume: 0.4 }),
    );
    expect((await settings.get()).volume).toBe(0.4);
  },
);

/** Real profile/playback/viewing modules; only the receiver and checkpoint completion are held. */
async function receiverLifetime() {
  const dataDir = await tempDir();
  const provider = await fakeProvider();
  let hear: (event: AdapterEvent) => void = () => {};
  let serial = 0;
  const stops: number[] = [];
  let checkpoint: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  let checkpointEntered = Promise.withResolvers<void>();
  let pause: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  let pauseEntered = Promise.withResolvers<void>();
  onTestFinished(() => {
    checkpoint?.resolve();
    pause?.resolve();
  });

  const adapter: ReceiverAdapter = {
    kind: "airplay",
    listen: (next) => {
      hear = next;
    },
    scan: (on) => {
      if (on) hear({ type: "receivers", receivers: [{ id: "tv", kind: "airplay", name: "TV" }] });
    },
    connect: async () => {
      const id = ++serial;

      return {
        receiver: { id: "tv", kind: "airplay", name: `TV ${id}` },
        localAddress: "127.0.0.1",
        decoders: ["h264", "aac"],
        volume: false,
        load: async () => {},
        play: async () => {},
        seek: async () => {},
        showSubtitles: async () => {},
        setVolume: async () => {},
        pause: async () => {
          pauseEntered.resolve();
          await pause?.promise;
        },
        stop: async () => {
          stops.push(id);
        },
        disconnect: async () => {},
      } satisfies Connection;
    },
    close: async () => {},
  };

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      ffmpeg: process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg",
      ffprobe:
        process.env["MR_STREAMER_FFMPEG"]?.replace(/ffmpeg(\.exe)?$/, "ffprobe$1") ?? "ffprobe",
      output: {
        adapters: [adapter],
        addresses: () => ["127.0.0.1"],
        fetchMs: 60_000,
        checkpointMs: 60_000,
      },
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        // Callback guards must stand independently of the switch's normal receiver cancellation.
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const source = await (await promised(runtime, Subscriptions)).add(demoLogin(provider));
  const sources = await (await promised(runtime, Subscriptions)).sources();
  const first = sources[0]!;

  const movie = provider.titles.movies.find((each) =>
    each.name.startsWith("TEST | Long subtitles"),
  )!;

  const title = { kind: "movie" as const, subscriptionId: source.id, id: String(movie.id) };
  const file = (await first.provider.titleFile("movie", title.id, movie.container)).url;
  const profiles = await promised(runtime, ProfileSessions);
  const output = await runtime.runPromise(Output);
  const a = await profiles.admit();

  const run = <A, E>(
    owner: Awaited<ReturnType<typeof profiles.admit>>,
    work: Effect.Effect<A, E>,
  ) => runtime.runPromise(owner.run(work));

  const scope = await runtime.runPromise(Scope.make());
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));

  const pull = await runtime.runPromise(
    Stream.toPull(output.changes).pipe(Effect.provideService(Scope.Scope, scope)),
  );

  const changes: OutputStatus[] = [];
  runtime.runFork(
    Effect.forever(Effect.flatMap(pull, (chunk) => Effect.sync(() => changes.push(...chunk)))),
  );
  await run(a, output.scan(true));
  await run(a, output.connect("tv"));

  const play = async (owner: typeof a) => {
    const captured = {
      ...owner.services.viewing,
      recordProgress: (...args: Parameters<ViewingRecord["Service"]["recordProgress"]>) =>
        Effect.gen(function* () {
          const held = checkpoint;

          if (held) {
            checkpointEntered.resolve();
            yield* Effect.promise(() => held.promise);
          }

          return yield* owner.services.viewing.recordProgress(...args);
        }),
    };

    const opened = await run(
      owner,
      output
        .openTitle(title, file, Date.now())
        .pipe(Effect.provideService(AdmittedViewing, { record: captured, run: owner.run })),
    );

    const media = await run(
      owner,
      output.playTitle(opened.sessionId, {
        position: 0,
        audio: null,
        subtitle: null,
        shown: { name: "Movie" },
      }),
    );

    hear({
      type: "status",
      status: {
        generation: media.generation,
        state: "playing",
        position: 3,
        at: Date.now(),
        duration: opened.duration,
      },
    });

    return media;
  };

  const old = await play(a);

  return {
    runtime,
    output,
    profiles,
    a,
    old,
    run,
    play,
    hear,
    stops,
    changes,
    holdCheckpoint: () => {
      checkpoint = Promise.withResolvers<void>();
      checkpointEntered = Promise.withResolvers<void>();

      return {
        entered: checkpointEntered.promise,
        release: () => {
          checkpoint?.resolve();
          checkpoint = null;
        },
      };
    },
    holdPause: () => {
      pause = Promise.withResolvers<void>();
      pauseEntered = Promise.withResolvers<void>();

      return {
        entered: pauseEntered.promise,
        release: () => {
          pause?.resolve();
          pause = null;
        },
      };
    },
    saved: () => run(a, a.services.viewing.progress({ movies: [title] })),
    flush: async (owner: typeof a) => {
      await run(owner, output.scan(true));
      await run(owner, output.scan(false));
      await vi.waitFor(() =>
        expect(changes.at(-1)).toMatchObject({ owner: owner.owner, scanning: false }),
      );
    },
  };
}

it.each(["media-failed", "stopped"] as const)(
  "a delayed %s checkpoint cannot reset replacement playback in the same profile or after a switch",
  async (event) => {
    for (const switchOwner of [false, true]) {
      const app = await receiverLifetime();
      const held = app.holdCheckpoint();

      if (event === "media-failed")
        app.hear({
          type: "media-failed",
          generation: app.old.generation,
          failure: { kind: "unreachable" },
        });
      else
        app.hear({
          type: "status",
          status: {
            generation: app.old.generation,
            state: "stopped",
            position: 3,
            at: Date.now(),
            duration: 12,
          },
        });
      await held.entered;

      if (switchOwner) await app.profiles.switch((await app.profiles.create("B")).id);
      const owner = await app.profiles.admit();
      await app.run(owner, app.output.connect("tv"));
      const replacement = await app.play(owner);
      const before = app.changes.length;
      held.release();
      // Wait for the original checkpoint's real durable write, then the public output barrier.
      await vi.waitFor(async () => expect(await app.saved()).toHaveLength(1));
      await app.flush(owner);
      const state = await app.run(owner, app.output.status);
      expect(state.output).toMatchObject({
        kind: "receiver",
        receiver: { name: "TV 2" },
        media: { generation: replacement.generation },
        failure: null,
      });
      expect(
        app.changes
          .slice(before)
          .every(
            (change) =>
              change.output.kind === "receiver" &&
              change.output.media?.generation === replacement.generation &&
              change.output.failure === null,
          ),
      ).toBe(true);
      expect(app.stops).not.toContain(2);
      await app.runtime.dispose();
    }
  },
  // Both profile lifecycles include real media probing and durable checkpoints.
  15_000,
);

it.each(["released", "lost"] as const)(
  "a queued %s callback does not checkpoint stale playback; a current callback still completes",
  async (event) => {
    for (const switchOwner of [true, false]) {
      const app = await receiverLifetime();
      const held = app.holdPause();
      const pausing = app.run(app.a, app.output.command(app.old.generation, { command: "pause" }));
      await held.entered;
      app.hear(
        event === "released"
          ? { type: "released" }
          : { type: "lost", failure: { kind: "unreachable" } },
      );

      if (switchOwner) await app.profiles.switch((await app.profiles.create("B")).id);
      const owner = await app.profiles.admit();

      const barrier = app.run(
        owner,
        app.output.command(app.old.generation + 100, { command: "pause" }),
      );

      held.release();
      await pausing;
      await barrier;
      expect(await app.saved()).toHaveLength(switchOwner ? 0 : 1);

      if (!switchOwner)
        expect((await app.run(owner, app.output.status)).output.kind).toBe(
          event === "released" ? "local" : "lost",
        );
      await app.run(owner, app.output.connect("tv"));
      const replacement = await app.play(owner);
      await app.flush(owner);
      expect((await app.run(owner, app.output.status)).output).toMatchObject({
        kind: "receiver",
        media: { generation: replacement.generation },
        failure: null,
      });
      expect(app.stops).not.toContain(2);
      await app.runtime.dispose();
    }
  },
  // Both profile lifecycles include real media probing and durable checkpoints.
  15_000,
);

it.each(["media-failed", "stopped"] as const)(
  "a current %s callback saves progress and publishes its actual outcome",
  async (event) => {
    const app = await receiverLifetime();
    app.hear(
      event === "media-failed"
        ? { type: "media-failed", generation: app.old.generation, failure: { kind: "unreachable" } }
        : {
            type: "status",
            status: {
              generation: app.old.generation,
              state: "stopped",
              position: 3,
              at: Date.now(),
              duration: 12,
            },
          },
    );
    await vi.waitFor(async () => {
      const state = await app.run(app.a, app.output.status);
      expect(state.output).toMatchObject({
        kind: "receiver",
        media: null,
        failure: event === "media-failed" ? { kind: "unreachable" } : null,
      });
      expect(await app.saved()).toHaveLength(1);
    });
  },
);

it.each(["released", "lost"] as const)(
  "a queued %s callback leaves a replacement load on the same connection and profile intact",
  async (event) => {
    const app = await receiverLifetime();
    const held = app.holdPause();
    const pausing = app.run(app.a, app.output.command(app.old.generation, { command: "pause" }));
    await held.entered;

    const replacement = app.run(
      app.a,
      app.output.playTitle(app.old.sessionId, {
        position: 0,
        audio: null,
        subtitle: null,
        shown: { name: "Replacement" },
      }),
    );

    app.hear(
      event === "released"
        ? { type: "released" }
        : { type: "lost", failure: { kind: "unreachable" } },
    );

    const barrier = app.run(
      app.a,
      app.output.command(app.old.generation + 100, { command: "pause" }),
    );

    held.release();
    await pausing;
    const media = await replacement;
    await barrier;
    await app.flush(app.a);
    expect((await app.run(app.a, app.output.status)).output).toMatchObject({
      kind: "receiver",
      media: { generation: media.generation },
      failure: null,
    });
  },
);

it("personal events keep their admitted revision through switching away and back", async () => {
  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(await tempDir()),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const provider = await fakeProvider();
  const source = await (await promised(runtime, Roster)).add(demoLogin(provider));
  await (await promised(runtime, Library)).refresh(source.id);
  const profiles = await promised(runtime, ProfileSessions);
  const a = await profiles.admit();
  const raw = await runtime.runPromise(ProfileSessions);
  const scope = await runtime.runPromise(Scope.make());
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const changes = await runtime.runPromise(raw.changes.pipe(Scope.provide(scope)));
  const events: Stream.Success<typeof changes>[] = [];
  runtime.runFork(Stream.runForEach(changes, (change) => Effect.sync(() => events.push(change))));
  const b = await profiles.switch((await profiles.create("B")).id);
  // The observed selection also establishes that this public event subscriber is listening.
  await vi.waitFor(() =>
    expect(
      events.some((event) => event.kind === "active" && event.active?.revision === b.revision),
    ).toBe(true),
  );

  const channel = {
    subscriptionId: source.id,
    id: String(provider.catalogue.channels[0]!.streamId),
  };

  await runtime.runPromise(a.run(a.services.viewing.recordWatch("late A", channel)));
  const viewingEvents = () => events.filter((event) => event.kind === "viewing");
  await vi.waitFor(() => expect(viewingEvents()).toHaveLength(1));
  expect(viewingEvents()[0]?.owner).toEqual(a.owner);
  const again = await profiles.switch(DEFAULT_PROFILE_ID);
  const current = await profiles.admit();
  await runtime.runPromise(current.run(current.services.viewing.recordWatch("new A", channel)));
  await vi.waitFor(() => expect(viewingEvents()).toHaveLength(2));
  expect(viewingEvents()[1]?.owner).toEqual(again);
});

it("admits subscription removal without holding a personal permit during household erasure, refusing stale owners and retrying failed erasure", async () => {
  const dataDir = await tempDir();

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const roster = await runtime.runPromise(Roster);
  const subscriptions = await runtime.runPromise(Subscriptions);
  const settings = await runtime.runPromise(Settings);
  const sessions = await runtime.runPromise(ProfileSessions);
  const profiles = await promised(runtime, ProfileSessions);
  const provider = await fakeProvider();
  const source = await runtime.runPromise(roster.add(demoLogin(provider)));

  const account = (await runtime.runPromise(subscriptions.saved)).find(
    (row) => row.id === source.id,
  )!.key;

  const a = await profiles.admit();
  const b = await profiles.create("B");

  const write = Effect.flatMap(ViewingStore, (store) =>
    store.commit({
      accounts: [account, "unrelated"],
      commandId: randomUUID(),
      at: Date.now(),
      decide: () => [
        { account, event: { type: "favourite-added", channelId: "removed" } },
        { account: "unrelated", event: { type: "favourite-added", channelId: "kept" } },
      ],
    }),
  );

  await runtime.runPromise(a.run(write));
  await profiles.switch(b.id);
  const admittedB = await profiles.admit();
  await runtime.runPromise(admittedB.run(write));
  await profiles.switch(a.owner.id);
  const current = await profiles.admit();
  registerIpc(
    runtime.runPromiseExit,
    subscriptionHandlers({ roster, subscriptions, settings }) as IpcHandlers,
    () => true,
    {
      admit: sessions.admitFor,
      handlers: () => ({}),
    },
  );
  const frame = { processId: 1, routingId: 1 };
  const event = { sender: { mainFrame: frame }, senderFrame: frame } as IpcMainInvokeEvent;

  const invoke = (owner: typeof a.owner) =>
    ipcBoundary.get("subscription.remove")!(event, {
      __profile: owner,
      input: { subscriptionId: source.id, eraseViewing: true },
    });

  expect((await invoke(a.owner)).ok).toBe(false);
  expect((await runtime.runPromise(subscriptions.saved)).some((row) => row.id === source.id)).toBe(
    true,
  );
  expect(
    await runtime.runPromise(
      current.run(
        Effect.flatMap(ViewingStore, (store) =>
          Effect.map(store.read([account]), (state) => state.favourites.map(({ id }) => id)),
        ),
      ),
    ),
  ).toEqual(["removed"]);
  const lock = new DatabaseSync(join(profileDirectory(dataDir, b.id), "mrstreamer.db"));

  try {
    lock.exec("begin immediate");
    expect((await invoke(current.owner)).ok).toBe(false);
    expect(
      (await runtime.runPromise(subscriptions.saved)).some((row) => row.id === source.id),
    ).toBe(true);
  } finally {
    lock.exec("rollback");
    lock.close();
  }

  expect(await invoke(current.owner)).toEqual({ ok: true, value: null });
  expect((await runtime.runPromise(subscriptions.saved)).some((row) => row.id === source.id)).toBe(
    false,
  );

  for (const id of [a.owner.id, b.id]) {
    await profiles.switch(id);
    const admission = await profiles.admit();
    expect(
      await runtime.runPromise(
        admission.run(
          Effect.flatMap(ViewingStore, (store) =>
            Effect.map(store.read([account, "unrelated"]), (state) =>
              state.favourites.map(({ id }) => id),
            ),
          ),
        ),
      ),
    ).toEqual(["kept"]);
  }
}, 10_000);

it("applies configured profile locale after catalogue success, retains captured settings across queued switches, and retries refused locale on restore", async () => {
  const dataDir = await tempDir();
  const applied: { owner: { id: string; revision: number }; choice: string | undefined }[] = [];
  let refuseCatalogue = false;
  let refuseLocale = false;
  let held = false;
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());

  const open = () =>
    runtimeFor(
      mainLayer({
        ...testConfig(dataDir),
        profiles: {
          consent: {
            read: Effect.sync(() => {
              if (refuseCatalogue) throw new Error("catalogue refused");

              return true;
            }),
            write: () => Effect.void,
          },
          stopInteractive: () => Effect.void,
          configured: (settings, owner) =>
            Effect.gen(function* () {
              if (held) {
                held = false;
                arrived.resolve();
                yield* Effect.promise(() => release.promise);
              }

              const choice = yield* settings.interfaceLanguage;

              if (refuseLocale)
                return yield* Effect.fail(
                  new Failed({ error: { kind: "unexpected", detail: "locale refused" } }),
                );
              applied.push({ owner, choice });
            }),
        },
      }),
    );

  const first = open();
  const profiles = await promised(first, ProfileSessions);
  const a = await profiles.admit();
  await first.runPromise(a.run(a.services.settings.setInterfaceLanguage("nl-NL")));
  const b = await profiles.create("B");
  refuseCatalogue = true;
  await expect(profiles.switch(b.id)).rejects.toBeDefined();
  expect(applied).toEqual([]);
  refuseCatalogue = false;
  refuseLocale = true;
  await expect(profiles.switch(b.id)).rejects.toMatchObject({
    error: { detail: "locale refused" },
  });
  await expect(profiles.admit()).rejects.toBeDefined();
  expect(applied).toEqual([]);
  refuseLocale = false;
  await profiles.switch(b.id);
  const admittedB = await profiles.admit();
  await first.runPromise(admittedB.run(admittedB.services.settings.setInterfaceLanguage("de-DE")));
  held = true;
  const switchingA = profiles.switch(a.owner.id);
  await arrived.promise;
  const switchingB = profiles.switch(b.id);
  release.resolve();
  const ownerA = await switchingA;
  const ownerB = await switchingB;
  expect(applied.slice(-2)).toEqual([
    { owner: ownerA, choice: "nl-NL" },
    { owner: ownerB, choice: "de-DE" },
  ]);
  expect(ownerB.revision).toBeGreaterThan(admittedB.owner.revision);
  await first.dispose();
  refuseLocale = true;
  const second = open();
  const restored = await promised(second, ProfileSessions);
  await expect(restored.admit()).rejects.toBeDefined();
  refuseLocale = false;
  await restored.switch(b.id);
  expect(applied.at(-1)).toEqual({ owner: await restored.active(), choice: "de-DE" });
  await second.dispose();
  const third = open();
  const restarted = await promised(third, ProfileSessions);
  expect(applied.at(-1)).toEqual({ owner: await restarted.active(), choice: "de-DE" });
});

it("recovers from unreadable selected preferences using the exact durable owner without admitting stale work", async () => {
  const dataDir = await tempDir();

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const profiles = await promised(runtime, ProfileSessions);
  const before = await profiles.active();
  const b = await profiles.create("B");
  await mkdir(profileDirectory(dataDir, b.id), { recursive: true });
  await writeFile(join(profileDirectory(dataDir, b.id), "preferences.json"), "{");
  await expect(profiles.switch(b.id, before)).rejects.toBeDefined();
  const selected = await profiles.active();
  await writeFile(join(profileDirectory(dataDir, b.id), "preferences.json"), "{}");
  await expect(profiles.switch(b.id, before)).rejects.toBeDefined();
  await expect(profiles.switch(before.id, before)).rejects.toBeDefined();
  await expect(profiles.admitFor(before)).rejects.toBeDefined();
  expect((await profiles.switch(before.id, selected)).id).toBe(before.id);
  expect((await profiles.admit()).owner.id).toBe(before.id);
});

it.each(["subscription.update", "playlist.map"] as const)(
  "%s waiting on household writes cannot hold the permit source erasure drains",
  async (method) => {
    const dataDir = await tempDir();

    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(dataDir),
        profiles: {
          consent: { read: Effect.succeed(true), write: () => Effect.void },
          stopInteractive: () => Effect.void,
        },
      }),
    );

    const subscriptions = await runtime.runPromise(Subscriptions);
    const roster = await runtime.runPromise(Roster);
    const settings = await runtime.runPromise(Settings);
    const sessions = await runtime.runPromise(ProfileSessions);
    const source = await runtime.runPromise(roster.add(demoLogin(await fakeProvider())));

    const server = createServer((_request, response) => {
      response.end('#EXTM3U\n#EXTINF:-1 group-title="Films",Film\nhttp://example.test/film.mp4\n');
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    onTestFinished(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    const address = server.address() as AddressInfo;

    const other = await runtime.runPromise(
      subscriptions.add({
        server: `http://127.0.0.1:${address.port}/list.m3u`,
        username: "",
        password: "",
      }),
    );

    const account = (await runtime.runPromise(subscriptions.saved))[0]!.key;
    const owner = await runtime.runPromise(sessions.active);
    const removing = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const handlers = subscriptionHandlers({ roster, subscriptions, settings });
    registerIpc(runtime.runPromiseExit, handlers as IpcHandlers, () => true, {
      admit: sessions.admitFor,
      handlers: () => ({
        "subscription.update": (input) =>
          Effect.andThen(
            Effect.sync(() => entered.resolve()),
            handlers["subscription.update"](input, "1:1"),
          ),
        "playlist.map": (input) =>
          Effect.andThen(
            Effect.sync(() => entered.resolve()),
            handlers["playlist.map"](input, "1:1"),
          ),
      }),
    });

    const removal = runtime.runPromiseExit(
      subscriptions.remove(source.id, {
        erase: Effect.gen(function* () {
          removing.resolve();
          yield* Effect.promise(() => entered.promise);
          yield* sessions.eraseSource(account).pipe(
            Effect.timeout("500 millis"),
            Effect.mapError(
              () =>
                new Failed({
                  error: { kind: "unexpected", detail: "Personal permits did not drain." },
                }),
            ),
          );
        }),
      }),
    );

    await removing.promise;
    const frame = { processId: 1, routingId: 1 };
    const event = { sender: { mainFrame: frame }, senderFrame: frame } as IpcMainInvokeEvent;

    const update = ipcBoundary.get(method)!(event, {
      __profile: { ...owner },
      input:
        method === "playlist.map"
          ? { subscriptionId: other.id, group: playlistGroupId("Films"), mode: "movie" }
          : { subscriptionId: other.id, name: "Renamed" },
    });

    const result = await removal;
    expect((await update).ok).toBe(true);
    expect(Exit.isSuccess(result)).toBe(true);
    expect(
      (await runtime.runPromise(subscriptions.saved)).some((row) => row.id === source.id),
    ).toBe(false);

    if (method === "playlist.map") {
      expect(
        await runtime.runPromise(subscriptions.playlistGroups(other.id, "", 0, 20)),
      ).toMatchObject({
        groups: [{ mode: "movie" }],
      });
    }
  },
);

it.each(["first", "later"])(
  "keeps untouched-source callbacks usable after the %s profile refuses erasure",
  async (lockedProfile) => {
    const dataDir = await tempDir();

    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(dataDir),
        profiles: {
          consent: { read: Effect.succeed(true), write: () => Effect.void },
          stopInteractive: () => Effect.void,
        },
      }),
    );

    const roster = await runtime.runPromise(Roster);
    const source = await runtime.runPromise(roster.add(demoLogin(await fakeProvider())));
    const other = await runtime.runPromise(roster.add(demoLogin(await fakeProvider())));
    const library = await runtime.runPromise(Library);
    await runtime.runPromise(library.refresh(source.id));
    await runtime.runPromise(library.refresh(other.id));
    const profiles = await promised(runtime, ProfileSessions);
    const sessions = await runtime.runPromise(ProfileSessions);
    const b = await profiles.create("B");
    await profiles.switch(b.id);
    const retainedB = await profiles.admit();

    const keptLists = await runtime.runPromise(
      retainedB.run(
        retainedB.services.lists.create({
          id: "b-list",
          name: "B",
          channel: { subscriptionId: source.id, id: "2014" },
        }),
      ),
    );

    const member = keptLists[0]!.members[0]!.member;
    await profiles.switch(DEFAULT_PROFILE_ID);
    const retained = await profiles.admit();
    await runtime.runPromise(
      retained.run(retained.services.lists.create({ id: "retained-list", name: "Saved" })),
    );
    const onDemand = await runtime.runPromise(OnDemand);
    await runtime.runPromise(onDemand.refresh(source.id));
    const subscriptions = await runtime.runPromise(Subscriptions);

    const account = (await runtime.runPromise(subscriptions.saved)).find(
      (row) => row.id === source.id,
    )!.key;

    const erased = { subscriptionId: source.id, id: "2014" };
    const untouched = { subscriptionId: other.id, id: "2014" };
    await runtime.runPromise(
      retained.run(retained.services.viewing.recordWatch("same-receipt", erased)),
    );

    const lock = new DatabaseSync(
      join(lockedProfile === "first" ? dataDir : profileDirectory(dataDir, b.id), "mrstreamer.db"),
    );

    try {
      lock.exec("begin immediate");
      await expect(
        runtime.runPromise(
          subscriptions.remove(source.id, { erase: sessions.eraseSource(account) }),
        ),
      ).rejects.toBeDefined();
    } finally {
      lock.exec("rollback");
      lock.close();
    }

    expect(
      (await runtime.runPromise(subscriptions.saved)).some((row) => row.id === source.id),
    ).toBe(true);
    await expect(
      runtime.runPromise(
        retained.run(retained.services.viewing.recordWatch("same-receipt", erased)),
      ),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    await expect(
      runtime.runPromise(retainedB.run(retainedB.services.viewing.recordWatch("late-b", erased))),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });

    const lateLists = await Promise.allSettled([
      runtime.runPromise(
        retained.run(retained.services.lists.setMember("retained-list", erased, true)),
      ),
      runtime.runPromise(
        retained.run(
          retained.services.watchlist.save("movie", { subscriptionId: source.id, id: "90002" }),
        ),
      ),
    ]);

    expect(lateLists.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    await expect(
      runtime.runPromise(retainedB.run(retainedB.services.lists.removeMember("b-list", member))),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    await runtime.runPromise(
      retained.run(retained.services.lists.setMember("retained-list", untouched, true)),
    );

    await runtime.runPromise(
      retained.run(retained.services.viewing.recordWatch("untouched", untouched)),
    );
    expect(
      (await runtime.runPromise(retained.run(retained.services.viewing.state))).recent,
    ).toEqual(lockedProfile === "first" ? [untouched, erased] : [untouched]);
    const fresh = await profiles.admit();
    await runtime.runPromise(
      fresh.run(fresh.services.lists.setMember("retained-list", erased, true)),
    );
    await runtime.runPromise(fresh.run(fresh.services.viewing.recordWatch("fresh", erased)));
    expect(
      (await runtime.runPromise(fresh.run(fresh.services.viewing.state))).recent,
    ).toContainEqual(erased);
    await profiles.switch(b.id);
    const freshB = await profiles.admit();
    await runtime.runPromise(freshB.run(freshB.services.lists.removeMember("b-list", member)));
    expect(
      (await runtime.runPromise(freshB.run(freshB.services.lists.lists))).find(
        (list) => list.id === "b-list",
      )?.members,
    ).toEqual([]);
  },
);

it("refuses a viewing command when its named source is erased while its channel read waits", async () => {
  const dataDir = await tempDir();
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  onTestFinished(() => release.resolve());
  let held = false;

  const runtime = runtimeFor(
    ViewingRecord.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          personalStoresLayer({ dataDir, profileId: DEFAULT_PROFILE_ID }),
          Layer.succeed(ViewingAccount, {
            owners: Effect.succeed([{ subscriptionId: "source", key: "account", original: true }]),
          }),
          Layer.succeed(ViewingChannels, {
            lookup: () =>
              Effect.gen(function* () {
                if (held) {
                  held = false;
                  arrived.resolve();
                  yield* Effect.promise(() => release.promise);
                }

                return () => undefined;
              }),
          }),
          Layer.succeed(ViewingSeries, {
            identity: () => Effect.die("unused series port"),
            seasons: () => Effect.die("unused series port"),
          }),
          Layer.succeed(LegacyViewing, { take: Effect.succeed(null), drop: Effect.void }),
        ),
      ),
    ),
  );

  const viewing = await runtime.runPromise(ViewingRecord);
  const store = await runtime.runPromise(ViewingStore);
  const title = { subscriptionId: "source", kind: "movie" as const, id: "movie" };
  let current = true;

  const command = viewing
    .recordProgress("same-command", title, 30, 100, 1)
    .pipe(Effect.provideService(ViewingErasure, { current: () => current }));

  await runtime.runPromise(command);
  held = true;
  const pending = runtime.runPromise(command);
  const refused = expect(pending).rejects.toMatchObject({ error: { kind: "no-subscription" } });
  await arrived.promise;
  current = false;
  await runtime.runPromise(store.erase("account"));
  release.resolve();
  await refused;
  expect(await runtime.runPromise(store.titles("account", {}))).toEqual([]);
});

it.each(["startup", "switch"] as const)(
  "keeps a rejected configured callback retryable after %s",
  async (phase) => {
    const dataDir = await tempDir();
    let refuse = false;

    const open = () =>
      runtimeFor(
        mainLayer({
          ...testConfig(dataDir),
          profiles: {
            consent: { read: Effect.succeed(true), write: () => Effect.void },
            stopInteractive: () => Effect.void,
            configured: () =>
              Effect.promise(async () => {
                if (refuse) throw new Error("fixture configured callback refused");
              }),
          },
        }),
      );

    if (phase === "startup") {
      const earlier = open();
      const saved = await promised(earlier, ProfileSessions);
      const b = await saved.create("B");
      await saved.switch(b.id);
      await earlier.dispose();
      refuse = true;
    }

    const runtime = open();
    const profiles = await promised(runtime, ProfileSessions);

    if (phase === "switch") {
      const b = await profiles.create("B");
      refuse = true;
      await expect(profiles.switch(b.id)).rejects.toMatchObject({
        error: { detail: "fixture configured callback refused" },
      });
    }

    await expect(profiles.admit()).rejects.toMatchObject({
      error: { detail: "fixture configured callback refused" },
    });
    const selected = await profiles.active();
    refuse = false;
    expect(await profiles.switch(selected.id, selected)).toEqual(selected);
    expect((await profiles.admit()).owner).toEqual(selected);
  },
);

// This refusal uses POSIX directory permissions; Windows and root ignore that fault fixture.
it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "refuses erasure before changing any owner while a later profile deletion is pending",
  async () => {
    const dataDir = await tempDir();

    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(dataDir),
        profiles: {
          consent: { read: Effect.succeed(true), write: () => Effect.void },
          stopInteractive: () => Effect.void,
        },
      }),
    );

    const profiles = await promised(runtime, ProfileSessions);
    const roster = await promised(runtime, Roster);
    const provider = await fakeProvider();
    const source = await roster.add(demoLogin(provider));
    const library = await promised(runtime, Library);
    await library.refresh(source.id);
    const a = await profiles.admit();
    const channel = { subscriptionId: source.id, id: "2014" };
    await runtime.runPromise(a.run(a.services.viewing.setFavourite("kept", channel, true)));
    const b = await profiles.create("B");
    await profiles.switch(b.id);
    await profiles.switch(a.owner.id);
    const parent = join(dataDir, "profiles");
    const mode = (await stat(parent)).mode & 0o777;
    await chmod(parent, 0o500);

    try {
      await expect(profiles.remove(b.id)).rejects.toBeDefined();
    } finally {
      await chmod(parent, mode);
    }

    expect((await profiles.list()).find(({ id }) => id === b.id)?.deleting).toBe(true);
    await expect(roster.remove(source.id, true)).rejects.toMatchObject({
      error: {
        kind: "unexpected",
        detail: "Finish deleting the pending profile before erasing a source.",
      },
    });
    const current = await profiles.admit();
    expect(
      (await runtime.runPromise(current.run(current.services.viewing.state))).favourites,
    ).toEqual([channel]);
    await profiles.remove(b.id);
    await roster.remove(source.id, true);
    const erased = await profiles.admit();
    expect(
      (await runtime.runPromise(erased.run(erased.services.viewing.state))).favourites,
    ).toEqual([]);
  },
);

it("settles source cleanup without recreating an inactive profile deleted in the meantime", async () => {
  const dataDir = await tempDir();

  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      profiles: {
        consent: { read: Effect.succeed(true), write: () => Effect.void },
        stopInteractive: () => Effect.void,
      },
    }),
  );

  const profiles = await promised(runtime, ProfileSessions);
  const sessions = await runtime.runPromise(ProfileSessions);
  const roster = await promised(runtime, Roster);
  const provider = await fakeProvider();
  const source = await roster.add(demoLogin(provider));
  const subscriptions = await promised(runtime, Subscriptions);
  const saved = (await subscriptions.saved()).find(({ id }) => id === source.id);

  if (!saved) throw new Error("No saved source");
  const b = await profiles.create("B");
  await profiles.switch(b.id);
  const admitted = await profiles.admit();
  await runtime.runPromise(admitted.run(admitted.services.settings.update({ volume: 0.25 })));
  await profiles.switch(DEFAULT_PROFILE_ID);
  const settle = await runtime.runPromise(sessions.prepareForget(saved));
  await profiles.remove(b.id);
  await expect(stat(profileDirectory(dataDir, b.id))).rejects.toMatchObject({ code: "ENOENT" });
  await runtime.runPromise(settle);
  await expect(stat(profileDirectory(dataDir, b.id))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await profiles.list()).map(({ id }) => id)).toEqual([DEFAULT_PROFILE_ID]);
});

it.each(["downloads.pause", "recordings.stop", "window.quit"] as const)(
  "%s remains available after configuration refuses while personal reads stay guarded",
  async (method) => {
    const dataDir = await tempDir();
    let refuse = false;

    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(dataDir),
        profiles: {
          consent: {
            read: Effect.sync(() => {
              if (refuse) throw new Error("fixture configuration refused");

              return true;
            }),
            write: () => Effect.void,
          },
          stopInteractive: () => Effect.void,
        },
      }),
    );

    const profiles = await promised(runtime, ProfileSessions);
    const sessions = await runtime.runPromise(ProfileSessions);
    const b = await profiles.create("B");
    refuse = true;
    await expect(profiles.switch(b.id)).rejects.toBeDefined();
    await expect(profiles.admit()).rejects.toBeDefined();
    const selected = await profiles.active();
    const entered: string[] = [];

    const control = (name: string) => () =>
      Effect.sync(() => {
        entered.push(name);

        return null;
      });

    // This IPC fixture registers only the four methods exercised here.
    const handlers: Partial<IpcHandlers> = {
      "downloads.pause": control("downloads.pause"),
      "recordings.stop": control("recordings.stop"),
      "window.quit": control("window.quit"),
      "preferences.get": () =>
        Effect.sync(() => {
          entered.push("preferences.get");

          return { revision: 1, preferences: defaultPreferences };
        }),
    };

    registerIpc(runtime.runPromiseExit, handlers as IpcHandlers, () => true, {
      admit: sessions.admitFor,
      handlers: () => ({}),
    });
    const frame = { processId: 1, routingId: 1 };
    const event = { sender: { mainFrame: frame }, senderFrame: frame } as IpcMainInvokeEvent;
    expect(
      await ipcBoundary.get(method)!(event, {
        __profile: { ...selected },
        input: method === "window.quit" ? undefined : { id: "held" },
      }),
    ).toEqual({ ok: true, value: null });
    expect(
      (
        await ipcBoundary.get("preferences.get")!(event, {
          __profile: { ...selected },
          input: undefined,
        })
      ).ok,
    ).toBe(false);
    expect(entered).toEqual([method]);
  },
);
