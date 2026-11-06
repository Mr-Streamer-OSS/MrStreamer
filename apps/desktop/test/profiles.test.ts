import {
  defaultPreferences,
  defaultSubscriptionPreferences,
} from "@mrstreamer/contracts/preferences";
import type { Connection, ReceiverAdapter, AdapterEvent } from "../src/main/receivers/adapter.ts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROFILE_ID } from "@mrstreamer/contracts/profiles";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
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
import { Settings } from "../src/main/services/preferences.ts";
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
    await (await started(dataDir)).dispose();
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

    await expect(runtime.runPromise(a.run(favourites))).rejects.toBeDefined();
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
  refuse = false;
  expect((await profiles.switch(b.id)).id).toBe(b.id);
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

it.each(["{", '{"volume":"unreadable"}'])(
  "refuses unreadable private preferences without saving defaults over them: %s",
  async (bytes) => {
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
  const events: Stream.Success<typeof raw.changes>[] = [];
  runtime.runFork(
    Stream.runForEach(raw.changes, (change) => Effect.sync(() => events.push(change))),
  );
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
