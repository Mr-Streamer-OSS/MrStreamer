import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROFILE_ID } from "@mrstreamer/contracts/profiles";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import { describe, expect, it } from "vitest";
import { Profiles } from "../src/main/platform/profile-store.ts";
import { mainLayer } from "../src/main/runtime.ts";
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

  it("answers no profile while its registry can't be written, and imports nothing twice once it can", async () => {
    const dataDir = await tempDir();
    const provider = await fakeProvider();
    // A subscription and the lists preferences.json kept before the viewing record and profiles.
    const login = runtimeFor(
      Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
    );
    const subscriptionId = (await (await promised(login, Subscriptions)).add(demoLogin(provider)))
      .id;
    await login.dispose();
    await writeFile(
      join(dataDir, "preferences.json"),
      JSON.stringify({
        volume: 0.4,
        muted: false,
        lastChannelId: null,
        lastCategoryId: null,
        favouriteChannelIds: ["2014", "2015"],
      }),
    );

    // Another copy of the app holds the write lock for all of the upgraded start.
    const holder = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    holder.exec("pragma journal_mode = wal; begin immediate");
    const refused = await started(dataDir);

    await expect(refused.profiles.active()).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });

    holder.exec("rollback");
    holder.close();

    expect(await refused.profiles.active()).toEqual(DEFAULT);
    await refused.dispose();
    const restarted = await started(dataDir);

    expect(await restarted.profiles.active()).toEqual(DEFAULT);
    expect((await restarted.viewing.state()).favourites).toEqual([
      { subscriptionId, id: "2014" },
      { subscriptionId, id: "2015" },
    ]);
    await restarted.dispose();
  });
});
