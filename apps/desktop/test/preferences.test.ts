import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const { id } = await subscriptions.connect(login);
  return { dataDir, settings, subscriptions, id, login };
}

const stored = async (dataDir: string): Promise<unknown> =>
  JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8"));

describe("preferences", () => {
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
    expect(await settings.get()).toEqual({ volume: 0.4, muted: false });
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

    expect(await returned.get()).toEqual({ volume: 0.9, muted: true });
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

    await settings.forget();

    expect(await stored(dataDir)).toEqual({
      volume: 0.4,
      muted: false,
      lastChannelId: null,
      lastCategoryId: null,
    });
    // The subscription connected next starts where none was left.
    await subscriptions.remove();
    const next = await subscriptions.connect(login);
    expect(await settings.ofSubscription(next.id)).toEqual({
      lastChannelId: null,
      lastCategoryId: null,
    });
    await expect(settings.ofSubscription(id)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });

  it("doesn't write what was left at a subscription another replaced while the change waited its turn", async () => {
    const { settings, subscriptions, id, login } = await connected();
    const ready = Promise.withResolvers<void>();
    disk.ready = ready.promise;
    const writing = settings.update({ volume: 0.4 });
    const late = settings.updateSubscription(id, { lastChannelId: "818" });
    late.catch(() => {});

    await subscriptions.remove();
    const next = await subscriptions.connect(login);
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

    expect(await (await settingsIn(dataDir)).get()).toEqual({ volume: 0.3, muted: true });
  });
});
