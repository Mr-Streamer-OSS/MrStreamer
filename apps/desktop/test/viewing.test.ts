import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { describe, expect, it, onTestFinished } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { createLibrary } from "../src/main/services/library.ts";
import { createPreferences } from "../src/main/services/preferences.ts";
import { createSubscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, tempDir, testSecrets, userAgent } from "./support.ts";

/**
 * The viewing record as the app runs it, on two fake providers to switch accounts between. `start`
 * ends the app running before, if any, and starts it again on the same data folder.
 */
async function viewingApp() {
  const dataDir = await tempDir();
  const providers = [await fakeProvider(), await fakeProvider()] as const;
  const subscriptions = createSubscriptions({
    dataDir,
    secrets: testSecrets,
    providerOptions: { userAgent },
  });
  const library = createLibrary({
    dataDir,
    source: subscriptions.source,
    onUpdated: () => {},
    confirmDelayMs: 0,
  });
  let running: { dispose(): Promise<void> } | null = null;

  const start = async () => {
    await running?.dispose();
    const runtime = ManagedRuntime.make(
      mainLayer({
        dataDir,
        source: subscriptions.source,
        library,
        preferences: createPreferences(dataDir),
      }),
    );
    running = runtime;
    onTestFinished(() => runtime.dispose());
    const viewing = await runtime.runPromise(
      Effect.gen(function* () {
        return yield* ViewingRecord;
      }),
    );
    const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
    return {
      state: () => run(viewing.state),
      setFavourite: (channelId: string, favourite: boolean, commandId: string = randomUUID()) =>
        run(viewing.setFavourite(commandId, channelId, favourite)),
      recordWatch: (channelId: string, commandId: string = randomUUID()) =>
        run(viewing.recordWatch(commandId, channelId)),
      /** The sequences the UI is told about from now on. */
      changes: async () => {
        const seen: number[] = [];
        runtime.runFork(
          Stream.runForEach(viewing.changes, (sequence) => Effect.sync(() => seen.push(sequence))),
        );
        await new Promise((resolve) => setTimeout(resolve, 10));
        return seen;
      },
    };
  };

  return {
    dataDir,
    start,
    connect: (account: 0 | 1) =>
      subscriptions.connect({ server: providers[account].url, username: "demo", password: "demo" }),
    disconnect: () => subscriptions.remove(),
    writePreferences: async (file: object) => {
      await mkdir(dataDir, { recursive: true });
      await writeFile(join(dataDir, "preferences.json"), JSON.stringify(file));
    },
    readPreferences: async (): Promise<unknown> =>
      JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8")),
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
    expect(await viewing.state()).toEqual({ favourites: [], recent: [], sequence: 0 });
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

  it("rebuilds the lists from the events when the stored state is gone", async () => {
    const app = await viewingApp();
    await app.connect(0);
    const viewing = await app.start();
    for (const id of ["a", "b", "c"]) await viewing.setFavourite(id, true);
    await viewing.setFavourite("b", false);
    for (const id of ["a", "b", "a"]) await viewing.recordWatch(id);
    const before = await viewing.state();
    await app.connect(1);
    await viewing.setFavourite("z", true);
    await app.connect(0);

    // What a change to the rules does: the state is dropped and the version no longer matches.
    const db = new DatabaseSync(join(app.dataDir, "mrstreamer.db"));
    db.exec("delete from state; delete from meta where key = 'state-version';");
    db.close();

    expect(await (await app.start()).state()).toEqual(before);
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
