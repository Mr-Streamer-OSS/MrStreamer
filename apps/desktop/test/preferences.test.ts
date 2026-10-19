import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Preferences, SubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import { ipcInputs } from "@mrstreamer/contracts/ipc";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

/** What writes of preferences.json wait for before they reach the disk, as on a slow one. */
const disk = vi.hoisted(() => ({ ready: Promise.resolve() }));
vi.mock("../src/main/platform/json-file.ts", async (original) => {
  const actual = await original<typeof import("../src/main/platform/json-file.ts")>();
  const writeJsonFile: typeof actual.writeJsonFile = async (path, value) => {
    if (path.endsWith("preferences.json")) await disk.ready;
    return actual.writeJsonFile(path, value);
  };
  return { ...actual, writeJsonFile };
});
afterEach(() => {
  disk.ready = Promise.resolve();
});

/** Settings and subscriptions on `dataDir`, as a new start of the app reads them. */
async function start(dataDir: string) {
  const runtime = runtimeFor(
    Settings.layer(dataDir).pipe(
      Layer.provideMerge(
        Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
      ),
    ),
  );
  return {
    settings: await promised(runtime, Settings),
    subscriptions: await promised(runtime, Subscriptions),
  };
}

const settingsIn = async (dataDir: string) => (await start(dataDir)).settings;

/** A data folder with a subscription connected, and that subscription's id. */
async function connected() {
  const provider = await fakeProvider();
  const dataDir = await tempDir();
  const { settings, subscriptions } = await start(dataDir);
  const login = { server: provider.url, username: "demo", password: "demo" };
  const { id } = await subscriptions.add(login);
  return { dataDir, settings, subscriptions, id, login };
}

/** The saved subscription `id` names, as the services know it. */
async function savedAs(
  subscriptions: Awaited<ReturnType<typeof start>>["subscriptions"],
  id: string,
) {
  const found = (await subscriptions.saved()).find((each) => each.id === id);
  if (!found) throw new Error(`${id} isn't saved`);
  return found;
}

const stored = async (dataDir: string): Promise<unknown> =>
  JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8"));

describe("preferences", () => {
  it("keeps Home row order, hidden and future rows across restart and subscription removal", async () => {
    const { dataDir, settings, subscriptions, id } = await connected();
    const homeRows = [
      { id: "watchlist", visible: false },
      { id: "future-row", visible: false },
      { id: "continue", visible: true },
    ];
    await settings.update({ homeRows });
    await settings.update({ volume: 0.4 });
    expect((await (await settingsIn(dataDir)).get()).homeRows).toEqual(homeRows);
    await settings.forget(await savedAs(subscriptions, id));
    expect((await (await settingsIn(dataDir)).get()).homeRows).toEqual(homeRows);
  });

  it("changes only what the UI sends, and survives a restart", async () => {
    const dataDir = await tempDir();
    await (await settingsIn(dataDir)).update({ audioLanguage: "nl", autoplayNext: false });

    const patch = ipcInputs["preferences.update"]()({ volume: 0.3, muted: true });
    if (patch instanceof type.errors) throw new Error(patch.summary);
    await (await settingsIn(dataDir)).update(patch);

    expect(await (await settingsIn(dataDir)).get()).toEqual({
      volume: 0.3,
      muted: true,
      audioLanguage: "nl",
      autoplayNext: false,
      nextEpisodeDelay: 10,
    });
  });

  it("keeps what the viewer left a subscription at apart, for that subscription alone", async () => {
    const { dataDir, settings, id } = await connected();
    await settings.update({ volume: 0.4 });

    await settings.updateSubscription(id, { lastChannelId: "818", lastCategoryId: "7" });
    await settings.updateSubscription(id, { titleVersions: { "movie:603": "4012" } });

    const left = {
      lastChannelId: "818",
      lastCategoryId: "7",
      titleVersions: { "movie:603": "4012" },
    };
    expect(await settings.ofSubscription(id)).toEqual(left);
    expect(await (await settingsIn(dataDir)).ofSubscription(id)).toEqual(left);
    expect(await settings.get()).toEqual({ volume: 0.4, muted: false, nextEpisodeDelay: 10 });
    // A subscription that isn't saved has none to read, and takes none.
    await expect(settings.ofSubscription("another-subscription")).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
    await expect(
      settings.updateSubscription("another-subscription", { lastChannelId: "5" }),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    expect(await settings.ofSubscription(id)).toEqual(left);
  });

  it("keeps the file as the stable release reads and writes it", async () => {
    const { dataDir, settings, id } = await connected();

    await settings.update({ volume: 0.4, liveQuality: "hd" });
    await settings.updateSubscription(id, {
      lastChannelId: "818",
      channelVariants: { "818": "819" },
    });

    // One flat file, every key where that release looks for it.
    expect(await stored(dataDir)).toEqual({
      volume: 0.4,
      muted: false,
      liveQuality: "hd",
      lastChannelId: "818",
      lastCategoryId: null,
      channelVariants: { "818": "819" },
    });

    // What that release then changes in it is what this one reads.
    await writeFile(
      join(dataDir, "preferences.json"),
      JSON.stringify({ volume: 0.9, muted: true, lastChannelId: "5", lastCategoryId: "2" }),
    );
    const returned = await settingsIn(dataDir);

    expect(await returned.get()).toEqual({ volume: 0.9, muted: true, nextEpisodeDelay: 10 });
    expect(await returned.ofSubscription(id)).toEqual({ lastChannelId: "5", lastCategoryId: "2" });
  });

  it("forgets what the viewer left the subscription at, but not the volume, when it goes", async () => {
    const { dataDir, settings, subscriptions, id, login } = await connected();
    await settings.update({ volume: 0.4 });
    await settings.updateSubscription(id, {
      lastChannelId: "818",
      lastCategoryId: "7",
      titleVersions: { "movie:603": "4012" },
      channelVariants: { "818": "819" },
    });

    const gone = await savedAs(subscriptions, id);
    await subscriptions.remove(id);
    await settings.forget(gone);

    expect(await stored(dataDir)).toEqual({
      volume: 0.4,
      muted: false,
      lastChannelId: null,
      lastCategoryId: null,
    });
    // The subscription connected next starts where none was left.
    const next = await subscriptions.add(login);
    expect(await settings.ofSubscription(next.id)).toEqual({
      lastChannelId: null,
      lastCategoryId: null,
    });
    await expect(settings.ofSubscription(id)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });

  it("keeps what was left at an added subscription in its own folder, apart from every other's", async () => {
    const { dataDir, settings, subscriptions, id } = await connected();
    const other = await fakeProvider();
    const added = await subscriptions.add({
      server: other.url,
      username: "demo",
      password: "demo",
    });
    await settings.updateSubscription(id, { lastChannelId: "818" });

    // The same ids as the first one's, which mean another channel and another film here.
    await settings.updateSubscription(added.id, {
      lastChannelId: "818",
      lastCategoryId: "2",
      titleVersions: { "movie:603": "9" },
    });
    await settings.updateSubscription(id, { lastCategoryId: "7" });

    const left = { lastChannelId: "818", lastCategoryId: "2", titleVersions: { "movie:603": "9" } };
    expect(await settings.ofSubscription(added.id)).toEqual(left);
    expect(await settings.ofSubscription(id)).toEqual({
      lastChannelId: "818",
      lastCategoryId: "7",
    });
    // The file every release reads holds the first one's alone.
    expect(await stored(dataDir)).toEqual({
      volume: 1,
      muted: false,
      lastChannelId: "818",
      lastCategoryId: "7",
    });
    expect(
      JSON.parse(
        await readFile(join(dataDir, "subscriptions", added.id, "preferences.json"), "utf8"),
      ),
    ).toEqual(left);
    expect(await (await settingsIn(dataDir)).ofSubscription(added.id)).toEqual(left);

    // It goes with its subscription, and the first one's stays.
    const gone = await savedAs(subscriptions, added.id);
    await subscriptions.remove(added.id);
    await settings.forget(gone);

    await expect(settings.ofSubscription(added.id)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
    expect(await settings.ofSubscription(id)).toEqual({
      lastChannelId: "818",
      lastCategoryId: "7",
    });
  });

  it("doesn't write what was left at a subscription that went while the change waited its turn", async () => {
    const { settings, subscriptions, id, login } = await connected();
    const ready = Promise.withResolvers<void>();
    disk.ready = ready.promise;
    const writing = settings.update({ volume: 0.4 });
    const late = settings.updateSubscription(id, { lastChannelId: "818" });
    late.catch(() => {});

    await subscriptions.remove(id);
    const next = await subscriptions.add(login);
    ready.resolve();
    await writing;

    await expect(late).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    expect(await settings.ofSubscription(next.id)).toEqual({
      lastChannelId: null,
      lastCategoryId: null,
    });
  });

  it("keeps what a newer version wrote when it saves", async () => {
    const dataDir = await tempDir();
    const newer = {
      volume: 1,
      muted: false,
      lastChannelId: null,
      lastCategoryId: null,
      subtitles: "nl",
    };
    await writeFile(join(dataDir, "preferences.json"), JSON.stringify(newer));

    await (await settingsIn(dataDir)).update({ volume: 0.5 });

    expect(await stored(dataDir)).toEqual({ ...newer, volume: 0.5 });
  });

  it("reads files that still carry favourites and recent channels, without them", async () => {
    const dataDir = await tempDir();
    await writeFile(
      join(dataDir, "preferences.json"),
      JSON.stringify({
        volume: 0.3,
        muted: true,
        lastChannelId: "5",
        lastCategoryId: null,
        recentChannelIds: ["5"],
        favouriteChannelIds: ["5"],
      }),
    );

    expect(await (await settingsIn(dataDir)).get()).toEqual({
      volume: 0.3,
      muted: true,
      nextEpisodeDelay: 10,
    });
  });
});

describe("the interface language", () => {
  it("survives a restart beside the other preferences, which it leaves alone", async () => {
    const dataDir = await tempDir();
    const settings = await settingsIn(dataDir);
    await settings.update({
      titleLanguage: "nl",
      audioLanguage: "original",
      subtitleLanguage: "en",
    });
    await settings.setInterfaceLanguage("de-DE");

    const returned = await settingsIn(dataDir);
    expect(await returned.interfaceLanguage()).toBe("de-DE");
    // The preferences the UI reads and changes don't carry it.
    expect(await returned.get()).toEqual({
      volume: 1,
      muted: false,
      titleLanguage: "nl",
      audioLanguage: "original",
      subtitleLanguage: "en",
      nextEpisodeDelay: 10,
    });
    await returned.setInterfaceLanguage("system");
    expect(await (await settingsIn(dataDir)).interfaceLanguage()).toBe("system");
  });

  it("is only ever set to a language this release speaks, or System default", () => {
    const set = ipcInputs["language.set"]();
    expect(set({ choice: "fr-FR" })).toEqual({ choice: "fr-FR" });
    expect(set({ choice: "system" })).toEqual({ choice: "system" });
    expect(set({ choice: "it-IT" })).toBeInstanceOf(type.errors);
    // Not through the preferences, which take their own keys alone.
    expect(ipcInputs["preferences.update"]()({ interfaceLanguage: "de-DE", muted: true })).toEqual({
      muted: true,
    });
  });

  it("keeps a language a later release saved, and the rest of the file with it", async () => {
    const dataDir = await tempDir();
    const later = { volume: 0.6, muted: false, lastChannelId: null, lastCategoryId: null };
    await writeFile(
      join(dataDir, "preferences.json"),
      JSON.stringify({ ...later, interfaceLanguage: "it-IT" }),
    );

    const settings = await settingsIn(dataDir);
    expect(await settings.interfaceLanguage()).toBe("it-IT");
    expect(await settings.get()).toEqual({ volume: 0.6, muted: false, nextEpisodeDelay: 10 });
    await settings.update({ muted: true });
    expect(await stored(dataDir)).toEqual({ ...later, muted: true, interfaceLanguage: "it-IT" });
  });

  it("stays when the original subscription goes", async () => {
    const { dataDir, settings, subscriptions, id } = await connected();
    await settings.setInterfaceLanguage("es-ES");
    const gone = await savedAs(subscriptions, id);
    await subscriptions.remove(id);
    await settings.forget(gone);

    expect(await (await settingsIn(dataDir)).interfaceLanguage()).toBe("es-ES");
  });
});

describe("the next-episode delay", () => {
  it.each([0, 1, 10, 37, 60])(
    "accepts and keeps exactly %i seconds across restart",
    async (nextEpisodeDelay) => {
      const dataDir = await tempDir();
      const patch = ipcInputs["preferences.update"]()({ nextEpisodeDelay });
      if (patch instanceof type.errors) throw new Error(patch.summary);
      expect((await (await settingsIn(dataDir)).update(patch)).nextEpisodeDelay).toBe(
        nextEpisodeDelay,
      );
      expect((await (await settingsIn(dataDir)).get()).nextEpisodeDelay).toBe(nextEpisodeDelay);
    },
  );

  it.each([-1, 0.5, 37.5, 61, NaN, Infinity, -Infinity, "37", null])(
    "rejects %s at IPC ingress",
    (nextEpisodeDelay) => {
      expect(ipcInputs["preferences.update"]()({ nextEpisodeDelay })).toBeInstanceOf(type.errors);
    },
  );

  it("defaults an absent delay without adding it to unrelated writes", async () => {
    const dataDir = await tempDir();
    const settings = await settingsIn(dataDir);
    expect((await settings.get()).nextEpisodeDelay).toBe(10);
    expect((await settings.update({ muted: true })).nextEpisodeDelay).toBe(10);
    expect(await stored(dataDir)).not.toHaveProperty("nextEpisodeDelay");
  });

  it.each([75, "future", { mode: "future" }, null, -1, 37.5])(
    "preserves unsupported raw %j through writes, older readers and original-source forgetting",
    async (nextEpisodeDelay) => {
      const { dataDir, subscriptions, id } = await connected();
      const raw = {
        volume: 0.4,
        muted: true,
        autoplayNext: false,
        nextEpisodeDelay,
        lastChannelId: "818",
        lastCategoryId: "7",
        titleVersions: { "movie:603": "4012" },
        channelVariants: { "818": "819" },
        favouriteChannelIds: ["818"],
        recentChannelIds: ["819"],
        interfaceLanguage: "de-DE",
        futurePreference: { mode: "kept" },
      };
      await writeFile(join(dataDir, "preferences.json"), JSON.stringify(raw));
      const settings = await settingsIn(dataDir);
      expect(await settings.get()).toMatchObject({
        volume: 0.4,
        muted: true,
        autoplayNext: false,
        nextEpisodeDelay: 10,
      });
      await settings.update({ volume: 0.6 });
      await settings.setInterfaceLanguage("fr-FR");
      await settings.updateSubscription(id, { lastChannelId: "9" });
      await settings.dropLegacyLists();
      await settings.forget(await savedAs(subscriptions, id));
      const expected = {
        volume: 0.6,
        muted: true,
        autoplayNext: false,
        nextEpisodeDelay,
        lastChannelId: null,
        lastCategoryId: null,
        interfaceLanguage: "fr-FR",
        futurePreference: { mode: "kept" },
      };
      expect(await stored(dataDir)).toEqual(expected);
      // Stable's schema has no delay key, and retains it when reconstructing the flat file.
      const stable = Preferences().omit("nextEpisodeDelay").merge(SubscriptionPreferences())(
        await stored(dataDir),
      );
      if (stable instanceof type.errors) throw new Error(stable.summary);
      await writeFile(
        join(dataDir, "preferences.json"),
        JSON.stringify({ ...stable, muted: false }),
      );
      const restarted = await settingsIn(dataDir);
      expect(await restarted.get()).toMatchObject({
        volume: 0.6,
        muted: false,
        nextEpisodeDelay: 10,
      });
      await restarted.update({ audioLanguage: "nl" });
      expect(await stored(dataDir)).toEqual({ ...expected, muted: false, audioLanguage: "nl" });
      await restarted.update({ nextEpisodeDelay: 37 });
      expect((await (await settingsIn(dataDir)).get()).nextEpisodeDelay).toBe(37);
      expect(await stored(dataDir)).toEqual({
        ...expected,
        muted: false,
        audioLanguage: "nl",
        nextEpisodeDelay: 37,
      });
    },
  );

  it("retains the acknowledged policy when a write fails", async () => {
    const dataDir = await tempDir();
    const settings = await settingsIn(dataDir);
    await settings.update({ nextEpisodeDelay: 37, autoplayNext: true });
    const blocked = Promise.withResolvers<void>();
    disk.ready = blocked.promise;
    const writing = settings.update({ nextEpisodeDelay: 0, autoplayNext: false });
    const failed = expect(writing).rejects.toBeDefined();
    blocked.reject(new Error("disk unavailable"));
    await failed;
    expect(await settings.get()).toMatchObject({ nextEpisodeDelay: 37, autoplayNext: true });
    expect(await (await settingsIn(dataDir)).get()).toMatchObject({
      nextEpisodeDelay: 37,
      autoplayNext: true,
    });
  });
});
