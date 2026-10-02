import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vitest";
import { Library } from "../src/main/services/library.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { QUALITY_STREAM_IDS } from "./fake-provider.ts";
import {
  collect,
  fakeProvider,
  promised,
  runtimeFor,
  tempDir,
  testSecrets,
  userAgent,
} from "./support.ts";

/**
 * A library on a connected fake provider, and the statuses it reports. `restart` starts another
 * on the same data folder.
 */
async function connectedLibrary(channels = 300, adultChannels = false) {
  const provider = await fakeProvider({ channels, adultChannels });
  const dataDir = await tempDir();
  const start = async () => {
    const runtime = runtimeFor(
      Library.layer({ dataDir, confirmDelay: 0 }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
            Settings.layer(dataDir),
          ),
        ),
      ),
    );
    const library = await promised(runtime, Library);
    return {
      library,
      settings: await promised(runtime, Settings),
      subscriptions: await promised(runtime, Subscriptions),
      updates: await collect(runtime, library.changes),
    };
  };
  const { library, settings, subscriptions, updates } = await start();
  await subscriptions.connect({ server: provider.url, username: "demo", password: "demo" });
  const restart = async () => (await start()).library;
  return { provider, dataDir, library, settings, updates, restart };
}

describe("live library", () => {
  it("loads categories and channels from the provider, without separator entries", async () => {
    const { provider, library, updates } = await connectedLibrary();

    const categories = await library.categories();
    const all = await library.channels({});

    const separators = provider.catalogue.channels.filter((channel) =>
      channel.name.startsWith("#####"),
    );
    expect(separators.length).toBeGreaterThan(0);
    expect(all.flatMap((channel) => channel.variants)).toHaveLength(
      provider.catalogue.channels.length - separators.length,
    );
    expect(all.some((channel) => channel.name.startsWith("#####"))).toBe(false);
    expect(categories[0]).toEqual({
      id: "1",
      name: "TEST | Formats and failures",
      group: null,
      title: "TEST | Formats and failures",
      channelCount: 13,
    });
    expect(categories[1]).toMatchObject({ group: "United Kingdom", title: "Entertainment" });
    expect(updates).toContainEqual({
      channelCount: all.length,
      fetchedAt: expect.any(Number),
      failure: null,
    });
  });

  it("normalises the provider's loose fields", async () => {
    const { library } = await connectedLibrary(2000);

    const channels = await library.channels({ categoryId: "2" });

    // The mock sends every third channel number as a string and some logos as "".
    expect(channels.every((channel) => typeof channel.number === "number")).toBe(true);
    expect(channels.some((channel) => channel.logoUrl === null)).toBe(true);
    expect(
      channels
        .filter((channel) => channel.logoUrl)
        .every((channel) => channel.logoUrl?.startsWith("http")),
    ).toBe(true);
    expect(channels.every((channel) => channel.categoryIds.includes("2"))).toBe(true);
  });

  it("ranks names that start with the query first and ignores case and punctuation", async () => {
    const { library } = await connectedLibrary(4000);

    const results = await library.channels({ query: "arena" });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every((channel) => channel.name.toLowerCase().includes("arena"))).toBe(true);
    const firstLater = results.findIndex(
      (channel) => !channel.name.toLowerCase().startsWith("arena"),
    );
    const lastStart = results.findLastIndex((channel) =>
      channel.name.toLowerCase().startsWith("arena"),
    );
    if (firstLater !== -1) expect(lastStart).toBeLessThan(firstLater);

    expect(await library.channels({ query: "test h 264 ac 3" })).toMatchObject([
      { name: "TEST | H.264 + AC-3" },
      { name: "TEST | H.264 + AC-3 DVB" },
      { name: "TEST | H.264 + E-AC-3" },
    ]);
  });

  it("shows a channel's qualities as one channel, found by any of its streams' ids", async () => {
    const { library } = await connectedLibrary();
    const fhd = String(QUALITY_STREAM_IDS);
    const hd = String(QUALITY_STREAM_IDS + 1);
    const sd = String(QUALITY_STREAM_IDS + 2);

    const found = await library.channels({ query: "kwaliteit" });

    expect(found).toMatchObject([
      {
        id: fhd,
        title: "Kwaliteit 1",
        tags: [],
        variants: [
          { id: fhd, tags: ["FHD"], quality: "fhd" },
          { id: hd, tags: ["HD"], quality: "hd" },
          { id: sd, tags: ["SD"], quality: "sd" },
        ],
      },
    ]);
    expect(await library.channel(sd)).toEqual(found[0]);
    expect(await library.channels({ ids: [sd, hd, fhd] })).toEqual(found);
  });

  it("serves the cached catalogue after a restart without the provider", async () => {
    const { provider, restart, library } = await connectedLibrary();
    const before = await library.channels({});
    await provider.close();

    const restarted = await restart();

    expect(await restarted.channels({})).toEqual(before);
    expect((await restarted.status()).channelCount).toBe(before.length);
  });

  it("keeps a catalogue saved before guide ids, and counts it as due for a refresh", async () => {
    const { provider, library, restart, dataDir } = await connectedLibrary();
    await library.refresh();
    const path = join(dataDir, "catalogue.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    // What a version without guide ids wrote: the same file, without the key.
    await writeFile(
      path,
      JSON.stringify(saved, (key, value) => (key === "guideId" ? undefined : value)),
    );
    provider.failCatalogue(500);

    const restarted = await restart();

    expect(await restarted.channels({})).toEqual(await library.channels({}));
    expect(await restarted.isStale(60 * 60 * 1000)).toBe(true);
    expect(await library.isStale(60 * 60 * 1000)).toBe(false);
  });

  it("keeps the last catalogue when a refresh fails", async () => {
    const { provider, library, updates } = await connectedLibrary();
    const before = await library.channels({});
    const { fetchedAt } = await library.status();

    provider.failCatalogue(503);
    await expect(library.refresh()).rejects.toMatchObject({
      error: { kind: "provider-error", status: 503 },
    });

    expect(await library.channels({})).toEqual(before);
    expect(await library.status()).toEqual({
      channelCount: before.length,
      fetchedAt,
      failure: { kind: "provider-error", status: 503 },
    });
    expect(updates.at(-1)).toEqual(await library.status());

    provider.failCatalogue(null);
    await library.refresh();
    expect((await library.status()).failure).toBeNull();
  });

  it("does not let an empty channel list replace the catalogue", async () => {
    const { provider, library } = await connectedLibrary();
    const before = await library.channels({});

    provider.serveChannels(() => []);

    await expect(library.refresh()).rejects.toMatchObject({
      error: { kind: "incomplete-catalogue", received: 0 },
    });
    expect(await library.channels({})).toEqual(before);
  });

  it("keeps the catalogue when the confirming fetch comes back empty", async () => {
    const { provider, library, restart } = await connectedLibrary();
    const before = await library.channels({});
    let requests = 0;
    provider.serveChannels((all) => (++requests === 1 ? all.slice(0, 5) : []));

    await expect(library.refresh()).rejects.toMatchObject({
      error: { kind: "incomplete-catalogue", received: 5 },
    });

    expect(await library.channels({})).toEqual(before);
    expect((await library.status()).failure).toMatchObject({ kind: "incomplete-catalogue" });
    expect(await (await restart()).channels({})).toEqual(before);
  });

  it("uses a much shorter channel list only when a second fetch confirms it", async () => {
    const { provider, library } = await connectedLibrary();
    const before = await library.channels({});
    let requests = 0;
    // A glitch: one short answer, then the full list again.
    provider.serveChannels((all) => (++requests === 1 ? all.slice(0, 40) : all));

    await expect(library.refresh()).rejects.toMatchObject({
      error: { kind: "incomplete-catalogue", received: 40 },
    });
    expect(await library.channels({})).toEqual(before);

    // A real change: the panel keeps sending the short list.
    provider.serveChannels((all) => all.slice(0, 40));
    await library.refresh();
    expect((await library.channels({})).length).toBeLessThan(40);
  });

  it("keeps channels by provider id when names and order change", async () => {
    const { provider, library } = await connectedLibrary();
    const [first, second] = await library.channels({ categoryId: "2" });
    if (!first || !second) throw new Error("Category 2 needs two channels");

    provider.serveChannels((all) =>
      all
        .filter((channel) => String(channel.streamId) !== second.id)
        .map((channel) =>
          String(channel.streamId) === first.id ? { ...channel, name: "UK: RENAMED ONE" } : channel,
        )
        .reverse(),
    );
    await library.refresh();

    // What the recently watched list asks for: the renamed channel stays, the removed one drops out.
    expect(await library.channels({ ids: [second.id, first.id] })).toMatchObject([
      { id: first.id, title: "Renamed One" },
    ]);
    await expect(library.channel(second.id)).rejects.toMatchObject({
      error: { kind: "channel-not-found" },
    });
  });

  it("keeps channels for adults to Live TV's lists while Settings shows them, and out of search", async () => {
    const { library, settings } = await connectedLibrary(300, true);
    // One flagged by the provider in an ordinary category, two in a category named for adults.
    const names = ["AFTER HOURS", "LATE SHOW", "NIGHT CLUB"];
    const all = async () => (await library.channels({})).map((channel) => channel.name);
    const ids = ["4000"];
    const adultCategory = async () =>
      (await library.categories()).find((category) => category.name === "XXX | ADULTS");

    expect((await all()).filter((name) => names.includes(name))).toEqual([]);
    expect(await adultCategory()).toBeUndefined();
    expect(await library.channels({ ids })).toEqual([]);
    await expect(library.channel("4000")).rejects.toMatchObject({
      error: { kind: "channel-not-found" },
    });
    expect((await library.guideChannels()).channelsOf("afterhours.adult")).toEqual([]);

    await settings.update({ adultTitles: true });

    expect((await all()).filter((name) => names.includes(name))).toEqual(names);
    expect(await adultCategory()).toMatchObject({ channelCount: 2 });
    expect((await library.channels({ ids })).map((channel) => channel.adult)).toEqual([true]);
    expect((await library.guideChannels()).channelsOf("afterhours.adult")).toHaveLength(1);
    expect(await library.channels({ query: "night club" })).toEqual([]);
    expect(await library.channels({ query: "after hours" })).toEqual([]);
  });

  it("reports a missing channel", async () => {
    const { library } = await connectedLibrary();

    await expect(library.channel("does-not-exist")).rejects.toMatchObject({
      error: { kind: "channel-not-found", channelId: "does-not-exist" },
    });
  });
});
