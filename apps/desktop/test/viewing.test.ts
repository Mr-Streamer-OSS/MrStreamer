import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { ViewingRecord, type TitleFilter } from "@mrstreamer/core/viewing/service";
import { describe, expect, it } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { QUALITY_STREAM_IDS, type FakeProviderOptions } from "./fake-provider.ts";
import {
  collect,
  fakeProvider,
  promised,
  runtimeFor,
  tempDir,
  testConfig,
  testSecrets,
  userAgent,
  type Promised,
} from "./support.ts";

/**
 * The viewing record as the app runs it, on two fake providers to switch accounts between, which
 * list the same channels under the same ids. `start` ends the app running before, if any, and
 * starts it again on the same data folder.
 */
async function viewingApp(options: FakeProviderOptions = {}) {
  const dataDir = await tempDir();
  const providers = [await fakeProvider(options), await fakeProvider(options)] as const;
  let running: {
    readonly dispose: () => Promise<void>;
    readonly subscriptions: Promised<Subscriptions["Service"]>;
  } | null = null;

  /** The running app's subscriptions, or a login made before it starts. */
  const subscriptions = async () =>
    running?.subscriptions ??
    promised(
      runtimeFor(
        Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
      ),
      Subscriptions,
    );

  const start = async () => {
    await running?.dispose();
    const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    running = {
      dispose: () => runtime.dispose(),
      subscriptions: await promised(runtime, Subscriptions),
    };
    const viewing = await promised(runtime, ViewingRecord);
    const library = await promised(runtime, Library);
    const settings = await promised(runtime, Settings);
    const { subscriptions } = running;
    return {
      library,
      state: viewing.state,
      setFavourite: (channelId: string, favourite: boolean, commandId: string = randomUUID()) =>
        viewing.setFavourite(commandId, channelId, favourite),
      /**
       * Saves `order` as an editor would that read the favourites as `original`: from the
       * connected account, unless `from` names the one it read them from.
       */
      reorder: async (
        original: readonly string[],
        order: readonly string[],
        { commandId = randomUUID(), from }: { commandId?: string; from?: string } = {},
      ) =>
        viewing.reorderFavourites(commandId, {
          subscription: from ?? (await subscriptions.key()) ?? "",
          original,
          order,
        }),
      /** The favourites Home, Live TV and Watch list, in their order: those the lists show. */
      listed: async () =>
        (await library.channels({ ids: (await viewing.state()).favourites })).map(({ id }) => id),
      /** What Settings does when the viewer turns titles for adults on. */
      showAdults: () => settings.update({ adultTitles: true }),
      account: async () => (await subscriptions.key()) ?? "",
      recordWatch: (channelId: string, commandId: string = randomUUID()) =>
        viewing.recordWatch(commandId, channelId),
      /** A checkpoint of a play that began at `since`, by default now. */
      played: (title: TitleRef, position: number, duration: number, since = Date.now()) =>
        viewing.recordProgress(randomUUID(), title, position, duration, since),
      remove: (filter: TitleFilter) => viewing.removeFromContinue(randomUUID(), filter),
      finish: (seriesIds: readonly string[]) => viewing.finishSeries(randomUUID(), seriesIds),
      progress: viewing.progress,
      /** The sequences the UI is told about from now on. */
      changes: () => collect(runtime, viewing.changes),
      /** What Remove subscription does with its box ticked. Returns the account's key. */
      erase: async () => {
        const key = (await running?.subscriptions.key()) ?? "";
        await viewing.erase(key);
        return key;
      },
    };
  };

  return {
    dataDir,
    providers,
    start,
    connect: async (account: 0 | 1) =>
      (await subscriptions()).connect({
        server: providers[account].url,
        username: "demo",
        password: "demo",
      }),
    disconnect: async () => (await subscriptions()).remove(),
    writePreferences: async (file: object) => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "preferences.json"), JSON.stringify(file));
    },
    readPreferences: async (): Promise<unknown> =>
      JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8")),
    /** Runs `use` on the database through a connection of its own, as another build's would be. */
    database: <A>(use: (db: DatabaseSync) => A): A => {
      const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
      try {
        return use(db);
      } finally {
        db.close();
      }
    },
  };
}

const settings = { volume: 0.4, muted: true, lastChannelId: "818", lastCategoryId: "7" };

describe("viewing record", () => {
  it("keeps favourites in the order added and twelve recent channels, across restarts", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();

    for (const id of ["a", "b", "c", "d"]) await viewing.setFavourite(id, true);
    await viewing.setFavourite("b", false);
    await viewing.setFavourite("a", true);
    for (const id of ["a", "b", "c", "a"]) await viewing.recordWatch(id);
    for (let index = 0; index < 20; index++) await viewing.recordWatch(`x${index}`);
    const latest = await viewing.recordWatch("b");

    expect(latest.favourites).toEqual(["a", "c", "d"]);
    expect(latest.recent).toHaveLength(12);
    expect(latest.recent.slice(0, 3)).toEqual(["b", "x19", "x18"]);
    expect(await (await app.start()).state()).toEqual(latest);
  });

  it("changes nothing more when a command arrives again", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();

    await viewing.setFavourite("a", true, "star");
    await viewing.setFavourite("a", false, "unstar");
    await viewing.recordWatch("a", "watch-a");
    const before = await viewing.recordWatch("b", "watch-b");

    expect(await viewing.setFavourite("a", true, "star")).toEqual(before);
    expect(await viewing.recordWatch("a", "watch-a")).toEqual(before);
    expect(before).toMatchObject({ favourites: [], recent: ["b", "a"] });
  });

  it("shows each account its own lists, and none without one", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    await viewing.setFavourite("a", true);

    await app.connect(1);
    expect(await viewing.state()).toMatchObject({ favourites: [], recent: [] });
    await viewing.setFavourite("b", true);

    await app.connect(0);
    expect((await viewing.state()).favourites).toEqual(["a"]);

    await app.disconnect();
    expect(await viewing.state()).toEqual({
      favourites: [],
      recent: [],
      continueWatching: [],
      sequence: 0,
    });
    await expect(viewing.setFavourite("c", true)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });

  it("tells the UI how far the record has come after each change", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    const seen = await viewing.changes();

    const first = await viewing.setFavourite("a", true);
    const second = await viewing.recordWatch("a");

    expect(seen).toEqual([first.sequence, second.sequence]);
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });

  it("brings in the lists preferences.json kept once, and leaves only the settings there", async () => {
    const app = await viewingApp();
    const lists = { favouriteChannelIds: ["f1", "f2"], recentChannelIds: ["r1", "r2", "r3"] };
    await app.writePreferences({ ...settings, ...lists });
    await app.connect(0);

    const viewing = await app.start();

    expect(await viewing.state()).toMatchObject({
      favourites: ["f1", "f2"],
      recent: ["r1", "r2", "r3"],
    });
    expect(await app.readPreferences()).toEqual(settings);

    // Lists back in the file, as after a crash before it was cleaned or a run of an older
    // version, are removed without being brought in again.
    await viewing.setFavourite("f1", false);
    await app.writePreferences({ ...settings, ...lists });
    const restarted = await app.start();

    expect((await restarted.state()).favourites).toEqual(["f2"]);
    expect(await app.readPreferences()).toEqual(settings);
  });

  it("keeps the lists in preferences.json until there is an account to bring them into", async () => {
    const app = await viewingApp();
    const lists = { favouriteChannelIds: ["f1"], recentChannelIds: ["r1"] };
    await app.writePreferences({ ...settings, ...lists });
    await app.start();

    expect(await app.readPreferences()).toEqual({ ...settings, ...lists });

    await app.connect(0);
    const restarted = await app.start();

    expect(await restarted.state()).toMatchObject({ favourites: ["f1"], recent: ["r1"] });
  });

  it("rebuilds the lists and titles from the events when the stored state is gone", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    for (const id of ["a", "b", "c"]) await viewing.setFavourite(id, true);
    await viewing.setFavourite("b", false);
    for (const id of ["a", "b", "a"]) await viewing.recordWatch(id);
    await viewing.played(movie("m1"), 600, 6000);
    await viewing.played(episode("e1", "s1", 1, 1), 2700, 2700);
    await viewing.played(movie("m2"), 900, 6000);
    await viewing.remove({ movieIds: ["m2"] });
    await viewing.played(episode("f9", "s2", 1, 9), 2700, 2700);
    await viewing.finish(["s2"]);
    const before = await viewing.state();
    const series = await viewing.progress({ seriesIds: ["s1"] });
    await app.connect(1);
    await viewing.setFavourite("z", true);
    await app.connect(0);

    // What a change to the rules does: the state is dropped and the version no longer matches.
    const db = new DatabaseSync(join(app.dataDir, "mrstreamer.db"));
    db.exec("delete from state; delete from titles; delete from meta where key = 'state-version';");
    db.close();

    const restarted = await app.start();
    expect(await restarted.state()).toEqual(before);
    expect(await restarted.progress({ seriesIds: ["s1"] })).toEqual(series);
  });

  it("opens a record written before movies and series, and keeps its lists", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    await viewing.setFavourite("a", true);
    const before = await viewing.state();
    await app.disconnect();
    await app.connect(0);

    // The database as the first builds with a viewing record wrote it: no payload, no titles.
    const db = new DatabaseSync(join(app.dataDir, "mrstreamer.db"));
    db.exec("drop table titles; alter table events drop column payload;");
    db.close();

    const restarted = await app.start();
    expect(await restarted.state()).toEqual(before);
    const played = await restarted.played(movie("m1"), 600, 6000);
    expect(played.continueWatching.map((entry) => entry.title)).toEqual([movie("m1")]);
  });
});

/** Lets the clock move on, so a play begun now began after what came before. */
function later(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("channels with several streams", () => {
  // The fake provider's channel in Full HD, HD and SD.
  const fhd = String(QUALITY_STREAM_IDS);
  const hd = String(QUALITY_STREAM_IDS + 1);
  const sd = String(QUALITY_STREAM_IDS + 2);

  it("shows lists kept by stream by channel, once each, and unstars every stream of it", async () => {
    const app = await viewingApp();
    // Lists as builds before channels joined their streams kept them: by stream.
    await app.writePreferences({
      ...settings,
      favouriteChannelIds: [hd, "gone"],
      recentChannelIds: [sd, fhd, "gone"],
    });
    await app.connect(0);
    const viewing = await app.start();
    await viewing.library.refresh();

    expect(await viewing.state()).toMatchObject({
      favourites: [fhd, "gone"],
      recent: [fhd, "gone"],
    });
    expect((await viewing.setFavourite(fhd, false)).favourites).toEqual(["gone"]);
  });

  it("keeps a starred channel when the provider drops or reorders its streams", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    await viewing.library.refresh();

    expect((await viewing.setFavourite(sd, true)).favourites).toEqual([fhd]);
    expect((await viewing.recordWatch(sd)).recent).toEqual([fhd]);
    // Builds before channels joined their streams, Stable 0.0.3 among them, read the stored
    // list as it is: they show the channel's three streams, and lose nothing.
    const db = new DatabaseSync(join(app.dataDir, "mrstreamer.db"));
    const stored = db.prepare("select favourites from state").get();
    db.close();
    expect(JSON.parse(String(stored?.["favourites"]))).toEqual([fhd, hd, sd]);

    const [provider] = app.providers;
    provider.serveChannels((all) => all.filter(({ streamId }) => String(streamId) !== fhd));
    await viewing.library.refresh();
    const { favourites } = await viewing.state();
    expect(await viewing.library.channels({ ids: favourites })).toMatchObject([
      { id: hd, title: "Kwaliteit 1", variants: [{ id: hd }, { id: sd }] },
    ]);

    provider.serveChannels((all) => all.toReversed());
    await viewing.library.refresh();
    expect((await viewing.state()).favourites).toEqual([fhd]);
  });
});

describe("the order of the favourites", () => {
  // Five of the fake provider's channels with one stream each, and its channel in three qualities.
  const [one, two, three, four, five] = ["1000", "1001", "1002", "1003", "1004"] as const;
  const fhd = String(QUALITY_STREAM_IDS);
  const hd = String(QUALITY_STREAM_IDS + 1);
  const sd = String(QUALITY_STREAM_IDS + 2);
  /** A channel the fake provider flags for adults, which the lists leave out by default. */
  const adult = "4000";

  /** The app on account 0 with its catalogue loaded and `ids` starred in that order. */
  async function withFavourites(ids: readonly string[], options: FakeProviderOptions = {}) {
    const app = await viewingApp(options);
    await app.connect(0);
    const viewing = await app.start();
    await viewing.library.refresh();
    for (const id of ids) await viewing.setFavourite(id, true);
    return { app, viewing, original: (await viewing.state()).favourites };
  }

  /** The stored favourites of an account: the provider's stream ids, as every build reads them. */
  const stored = (app: Awaited<ReturnType<typeof viewingApp>>, account: string): string[] =>
    app.database((db) => {
      const row = db.prepare("select favourites from state where account = ?").get(account);
      return JSON.parse(String(row?.["favourites"]));
    });

  it("lists the favourites in the order saved, across restarts, and puts a new one last", async () => {
    const { app, viewing, original } = await withFavourites([one, two, sd, three]);
    await viewing.recordWatch(two);
    await viewing.played(movie("m1"), 600, 6000);
    const before = await viewing.state();
    expect(original).toEqual([one, two, fhd, three]);

    const saved = await viewing.reorder(original, [three, fhd, one, two]);

    expect(saved.favourites).toEqual([three, fhd, one, two]);
    // History and progress are as they were, and so is what the provider says of each channel.
    expect(saved.recent).toEqual(before.recent);
    expect(saved.continueWatching).toEqual(before.continueWatching);
    const channels = await viewing.library.channels({ ids: saved.favourites });
    expect(channels.map(({ id, number }) => [id, number])).toEqual(
      [three, fhd, one, two].map((id) => [id, expect.any(Number)]),
    );
    expect(channels[1]?.variants.map(({ id }) => id)).toEqual([fhd, hd, sd]);

    const restarted = await app.start();
    expect(await restarted.listed()).toEqual([three, fhd, one, two]);
    // A channel starred now goes last, and so does one unstarred and starred again.
    await restarted.setFavourite(four, true);
    await restarted.setFavourite(three, false);
    await restarted.setFavourite(three, true);
    expect(await restarted.listed()).toEqual([fhd, one, two, four, three]);
  });

  it("moves a channel with every stream stored of it, and keeps its place when the provider drops or reorders them", async () => {
    const { app, viewing, original } = await withFavourites([sd, one, two]);

    await viewing.reorder(original, [one, fhd, two]);

    expect(stored(app, await viewing.account())).toEqual([one, fhd, hd, sd, two]);
    const [provider] = app.providers;
    provider.serveChannels((all) => all.filter(({ streamId }) => String(streamId) !== fhd));
    await viewing.library.refresh();
    expect(await viewing.listed()).toEqual([one, hd, two]);

    provider.serveChannels((all) => all.toReversed());
    await viewing.library.refresh();
    expect(await viewing.listed()).toEqual([one, fhd, two]);
    expect(await (await app.start()).listed()).toEqual([one, fhd, two]);
  });

  it("leaves the favourites the lists don't show where they are, and adds or removes none", async () => {
    const { viewing, original } = await withFavourites([one, adult, two, "gone", three], {
      adultChannels: true,
    });
    expect(original).toEqual([one, adult, two, "gone", three]);
    expect(await viewing.listed()).toEqual([one, two, three]);

    const saved = await viewing.reorder(original, [three, one, two]);

    expect(saved.favourites).toEqual([three, adult, one, "gone", two]);
    // Shown again, the channel for adults is where it was among the others.
    await viewing.showAdults();
    expect(await viewing.listed()).toEqual([three, adult, one, two]);

    // An order can only arrange favourites: none twice, and no channel that isn't one.
    for (const order of [
      [one, one, two],
      [one, two, four],
    ]) {
      await expect(viewing.reorder(saved.favourites, order)).rejects.toMatchObject({
        error: { kind: "invalid-input" },
      });
    }
    expect((await viewing.state()).favourites).toEqual(saved.favourites);
  });

  it("refuses an order made from favourites that changed since, and takes one whatever was watched meanwhile", async () => {
    const { app, viewing, original } = await withFavourites([one, two, sd]);
    const refused = { error: { kind: "favourites-changed" } };

    // Watching a channel and a movie moves the record on, and leaves the favourites alone.
    await viewing.recordWatch(one);
    await viewing.played(movie("m1"), 600, 6000);
    expect((await viewing.reorder(original, [two, one, fhd])).favourites).toEqual([two, one, fhd]);

    // A favourite starred since.
    const reordered = (await viewing.state()).favourites;
    await viewing.setFavourite(three, true);
    await expect(viewing.reorder(reordered, [fhd, one, two])).rejects.toMatchObject(refused);

    // The provider dropped a stream since, so the channel shows by another of them.
    const starred = (await viewing.state()).favourites;
    const [provider] = app.providers;
    provider.serveChannels((all) => all.filter(({ streamId }) => String(streamId) !== fhd));
    await viewing.library.refresh();
    await expect(viewing.reorder(starred, [three, fhd, one, two])).rejects.toMatchObject(refused);

    expect(await viewing.listed()).toEqual([two, one, hd, three]);
  });

  it("keeps each subscription's order to itself, though they list the same channels", async () => {
    const { app, viewing, original } = await withFavourites([one, two, three]);
    const first = await viewing.account();
    await app.connect(1);
    await viewing.library.refresh();
    for (const id of [one, two, three]) await viewing.setFavourite(id, true);
    const second = await viewing.account();

    // An order made on the first account arrives once the second is connected: it lands on
    // neither, though the second's favourites look the same.
    await expect(
      viewing.reorder(original, [three, two, one], { from: first }),
    ).rejects.toMatchObject({ error: { kind: "favourites-changed" } });
    expect(stored(app, first)).toEqual([one, two, three]);
    expect(stored(app, second)).toEqual([one, two, three]);

    await viewing.reorder(original, [two, three, one]);
    expect(stored(app, second)).toEqual([two, three, one]);
    await app.connect(0);
    expect((await viewing.state()).favourites).toEqual([one, two, three]);
  });

  it("saves an order once however often it is sent, and writes nothing for one that changes nothing", async () => {
    const { viewing, original } = await withFavourites([one, two, three, four]);

    const saved = await viewing.reorder(original, [four, one, two, three], { commandId: "first" });
    // Sent again, as when its answer never arrived: the list it was made from is no longer the
    // one stored, and it is still done.
    expect(
      await viewing.reorder(original, [four, one, two, three], { commandId: "first" }),
    ).toEqual(saved);

    const later = await viewing.reorder(saved.favourites, [three, four, one, two]);
    expect(later.sequence).toBeGreaterThan(saved.sequence);
    // The first one late, after a newer order: the newer stands.
    expect(
      await viewing.reorder(original, [four, one, two, three], { commandId: "first" }),
    ).toEqual(later);
    expect(await viewing.reorder(later.favourites, [three, four, one, two])).toEqual(later);
  });

  it("keeps the order and the favourites when the database fails while saving, and saves on the retry", async () => {
    const { app, viewing, original } = await withFavourites([one, two, sd, three]);
    const before = await viewing.state();
    // The disk gives out part of the way through what a new order writes.
    app.database((db) =>
      db.exec(`create trigger full before insert on events when new.type = 'favourite-added'
               begin select raise(abort, 'disk full'); end`),
    );

    await expect(
      viewing.reorder(original, [three, fhd, two, one], { commandId: "save" }),
    ).rejects.toMatchObject({ error: { kind: "unexpected" } });
    expect(await viewing.state()).toEqual(before);
    expect(stored(app, await viewing.account())).toEqual([one, two, fhd, hd, sd, three]);

    app.database((db) => db.exec("drop trigger full"));
    const saved = await viewing.reorder(original, [three, fhd, two, one], { commandId: "save" });
    expect(saved.favourites).toEqual([three, fhd, two, one]);
  });

  it("writes an order as favourites removed and added, which older builds and a rebuild read the same", async () => {
    const { app, viewing, original } = await withFavourites([one, two, sd, three, four]);
    const first = await viewing.reorder(original, [four, three, fhd, two, one]);
    await viewing.setFavourite(five, true);
    const second = await viewing.reorder(
      [...first.favourites, five],
      [five, fhd, four, one, three, two],
    );
    const account = await viewing.account();

    // A build from before favourites could be ordered knows these events alone, and works the
    // list out from them as it always did.
    const events = app.database((db) =>
      db
        .prepare("select type, channel_id from events where account = ? order by sequence")
        .all(account),
    );
    const replayed = new Set<string>();
    for (const event of events) {
      const id = String(event["channel_id"]);
      if (event["type"] === "favourite-added") replayed.add(id);
      else if (event["type"] === "favourite-removed") replayed.delete(id);
      else throw new Error(`An older build skips ${String(event["type"])}.`);
    }
    expect([...replayed]).toEqual([five, fhd, hd, sd, four, one, three, two]);
    expect(stored(app, account)).toEqual([...replayed]);

    // What a change to the rules does: the lists are worked out from every event again.
    app.database((db) =>
      db.exec("delete from state; delete from meta where key = 'state-version';"),
    );
    expect(await (await app.start()).state()).toEqual(second);
  });
});

function movie(id: string): TitleRef {
  return { kind: "movie", id };
}

function episode(id: string, seriesId: string, season: number, number: number): TitleRef {
  return { kind: "episode", id, seriesId, season, episode: number };
}

describe("how far movies and episodes got", () => {
  it("lists movies started and not finished, and the latest episode of each series", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();

    await viewing.played(movie("barely"), 60, 6000);
    await viewing.played(movie("halfway"), 3000, 6000);
    await viewing.played(movie("credits"), 5800, 6000);
    await viewing.played(episode("e1", "s1", 1, 1), 2650, 2700);
    await viewing.played(episode("e2", "s1", 1, 2), 30, 2700);
    await viewing.played(episode("p1", "pilot", 1, 1), 20, 2700);
    const state = await viewing.played(movie("halfway"), 3100, 6000);

    // The movie played last comes first; a series stays with its next episode even when that one
    // has barely started, and a pilot watched for seconds doesn't count yet.
    expect(
      state.continueWatching.map(({ title, position, finished }) => [title, position, finished]),
    ).toEqual([
      [movie("halfway"), 3100, false],
      [episode("e2", "s1", 1, 2), 30, false],
    ]);
    expect(await viewing.progress({ movieIds: ["credits", "unknown"] })).toMatchObject([
      { title: movie("credits"), finished: true },
    ]);
    expect(
      (await viewing.progress({ seriesIds: ["s1"] })).map((entry) => entry.title.id).sort(),
    ).toEqual(["e1", "e2"]);
    expect((await (await app.start()).state()).continueWatching).toEqual(state.continueWatching);
  });

  it("offers more titles than the row shows, so the ones the UI leaves out don't push others off", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    await viewing.played(movie("ordinary"), 600, 6000);
    // Twenty-five later ones, as films for adults the row leaves out would be.
    let state = await viewing.state();
    for (let index = 0; index < 25; index++)
      state = await viewing.played(movie(`m${index}`), 600, 6000);

    expect(state.continueWatching).toHaveLength(26);
    expect(state.continueWatching.at(-1)?.title).toEqual(movie("ordinary"));
  });

  it("keeps a finished episode in Continue watching, so its series offers the next one", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();

    const state = await viewing.played(episode("e3", "s1", 2, 3), 2690, 2700);

    expect(state.continueWatching).toMatchObject([
      { title: episode("e3", "s1", 2, 3), finished: true },
    ]);
  });

  it("takes every version of a movie or series out of Continue watching, across restarts, until played again", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    // Two versions of a film and two of a series, each played; another film stays.
    await viewing.played(movie("m1-nl"), 600, 6000);
    await viewing.played(movie("m1-4k"), 900, 6000);
    await viewing.played(episode("e1", "s1-nl", 1, 1), 600, 2700);
    await viewing.played(episode("e2", "s1-nl", 1, 2), 600, 2700);
    await viewing.played(episode("f1", "s1-en", 1, 1), 600, 2700);
    await viewing.played(movie("m2"), 600, 6000);

    await viewing.remove({ movieIds: ["m1-nl", "m1-4k", "m1-unplayed"] });
    const removed = await viewing.remove({ seriesIds: ["s1-nl", "s1-en"] });
    expect(removed.continueWatching.map((entry) => entry.title)).toEqual([movie("m2")]);

    const restarted = await app.start();
    expect((await restarted.state()).continueWatching.map((entry) => entry.title)).toEqual([
      movie("m2"),
    ]);
    // How far they got stays, for the details' Resume.
    expect(await restarted.progress({ movieIds: ["m1-4k"] })).toMatchObject([{ position: 900 }]);

    await later();
    const again = await restarted.played(episode("e2", "s1-nl", 1, 2), 700, 2700);
    expect(again.continueWatching.map((entry) => entry.title)).toEqual([
      episode("e2", "s1-nl", 1, 2),
      movie("m2"),
    ]);
  });

  it("keeps a title out while the play going on when it was removed saves its progress", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    const began = Date.now();
    await viewing.played(movie("m1"), 600, 6000, began);
    await viewing.played(episode("e1", "s1", 1, 1), 600, 2700, began);
    await viewing.remove({ movieIds: ["m1"], seriesIds: ["s1"] });

    // Checkpoints a minute on, and the next episode of the same play.
    await viewing.played(movie("m1"), 660, 6000, began);
    const going = await viewing.played(episode("e2", "s1", 1, 2), 30, 2700, began);
    expect(going.continueWatching).toEqual([]);
    expect(await viewing.progress({ movieIds: ["m1"] })).toMatchObject([{ position: 660 }]);

    await later();
    const resumed = await viewing.played(movie("m1"), 700, 6000);
    expect(resumed.continueWatching.map((entry) => entry.title)).toEqual([movie("m1")]);
  });

  it("takes a finished series out of Continue watching, every version played, until a play begun afterwards", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    const began = Date.now();
    // The Dutch version partly watched once, then the English one to its last episode.
    await viewing.played(episode("nl1", "s1-nl", 1, 1), 600, 2700, began - 60_000);
    await viewing.played(episode("en2", "s1-en", 1, 2), 2690, 2700, began);
    await viewing.played(movie("m1"), 600, 6000);

    const finished = await viewing.finish(["s1-nl", "s1-en", "s1-unplayed"]);
    expect(finished.continueWatching.map((entry) => entry.title)).toEqual([movie("m1")]);
    // Leaving the end saves that play once more.
    await viewing.played(episode("en2", "s1-en", 1, 2), 2700, 2700, began);

    const restarted = await app.start();
    expect((await restarted.state()).continueWatching.map((entry) => entry.title)).toEqual([
      movie("m1"),
    ]);
    await later();
    const again = await restarted.played(episode("nl1", "s1-nl", 1, 1), 700, 2700);
    expect(again.continueWatching.map((entry) => entry.title)).toEqual([
      episode("nl1", "s1-nl", 1, 1),
      movie("m1"),
    ]);
  });

  it("opens a record from before removal times, keeping what it took out", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    await viewing.played(movie("m1"), 600, 6000);
    await viewing.played(movie("m2"), 600, 6000);
    await viewing.remove({ movieIds: ["m1"] });
    await app.disconnect();
    await app.connect(0);

    // The titles table as Stable 0.0.3 writes it.
    const db = new DatabaseSync(join(app.dataDir, "mrstreamer.db"));
    db.exec("alter table titles drop column removed_at;");
    db.close();

    const restarted = await app.start();
    expect((await restarted.state()).continueWatching.map((entry) => entry.title)).toEqual([
      movie("m2"),
    ]);
    await later();
    const again = await restarted.played(movie("m1"), 700, 6000);
    expect(again.continueWatching.map((entry) => entry.title)).toEqual([movie("m1"), movie("m2")]);
  });

  it("keeps each account's progress and removals to itself", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    await viewing.played(movie("m1"), 600, 6000);
    await viewing.played(movie("m2"), 600, 6000);
    await viewing.remove({ movieIds: ["m2"] });

    await app.connect(1);
    expect((await viewing.state()).continueWatching).toEqual([]);
    expect(await viewing.progress({ movieIds: ["m1"] })).toEqual([]);
    await viewing.played(movie("m2"), 600, 6000);
    await viewing.remove({ movieIds: ["m1"] });

    await app.connect(0);
    expect(await viewing.progress({ movieIds: ["m1"] })).toMatchObject([{ position: 600 }]);
    expect((await viewing.state()).continueWatching.map((entry) => entry.title)).toEqual([
      movie("m1"),
    ]);
  });

  it("fails its calls, and keeps the lists in preferences.json, when the database can't open", async () => {
    const app = await viewingApp();
    await app.writePreferences({ ...settings, favouriteChannelIds: ["f1"] });
    await mkdir(join(app.dataDir, "mrstreamer.db"));
    await app.connect(0);

    const viewing = await app.start();

    await expect(viewing.state()).rejects.toMatchObject({ error: { kind: "unexpected" } });
    expect(await app.readPreferences()).toMatchObject({ favouriteChannelIds: ["f1"] });
  });
});

describe("erasing an account's record", () => {
  it("deletes its favourites, history and progress for good, and only its own", async () => {
    const app = await viewingApp();
    await app.connect(1);
    const viewing = await app.start();
    await viewing.setFavourite("z", true);
    await viewing.played(movie("m9"), 600, 6000);
    const other = await viewing.state();
    await app.connect(0);
    await viewing.setFavourite("a", true);
    await viewing.recordWatch("a");
    await viewing.played(movie("m1"), 600, 6000);
    await viewing.played(episode("e1", "s1", 1, 1), 600, 2700);
    await viewing.remove({ movieIds: ["m1"] });

    const key = await viewing.erase();

    const empty = { favourites: [], recent: [], continueWatching: [] };
    expect(await viewing.state()).toMatchObject(empty);
    expect(await viewing.progress({ movieIds: ["m1"], seriesIds: ["s1"] })).toEqual([]);
    // Nothing of it stays in the file, for this build or an older one to find.
    const file = Buffer.concat(
      await Promise.all(
        ["mrstreamer.db", "mrstreamer.db-wal"].map((name) =>
          readFile(join(app.dataDir, name)).catch(() => Buffer.alloc(0)),
        ),
      ),
    );
    expect(file.includes(key)).toBe(false);

    // What a change to the rules does: the next start rebuilds everything from the events.
    const db = new DatabaseSync(join(app.dataDir, "mrstreamer.db"));
    db.exec("delete from state; delete from titles; delete from meta where key = 'state-version';");
    db.close();
    const restarted = await app.start();
    expect(await restarted.state()).toMatchObject(empty);
    await app.connect(1);
    expect(await restarted.state()).toEqual(other);
  });
});
