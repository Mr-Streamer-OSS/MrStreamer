import { describe, expect, it, vi } from "vitest";
import { createLibrary } from "../src/main/services/library.ts";
import { createSubscriptions } from "../src/main/services/subscription.ts";
import { mockProvider, tempDir, testSecrets, userAgent } from "./support.ts";

async function connectedLibrary(channels = 300) {
  const provider = await mockProvider({ channels });
  const dataDir = await tempDir();
  const subscriptions = createSubscriptions({
    dataDir,
    secrets: testSecrets,
    providerOptions: { userAgent },
  });
  await subscriptions.connect({ server: provider.url, username: "demo", password: "demo" });
  const onUpdated = vi.fn();
  const create = () => createLibrary({ dataDir, source: subscriptions.source, onUpdated });
  return { provider, subscriptions, onUpdated, create, library: create() };
}

describe("live library", () => {
  it("loads categories and channels from the provider, without separator entries", async () => {
    const { provider, library, onUpdated } = await connectedLibrary();

    const categories = await library.categories();
    const all = await library.channels({});

    const separators = provider.catalogue.channels.filter((channel) =>
      channel.name.startsWith("#####"),
    );
    expect(separators.length).toBeGreaterThan(0);
    expect(all).toHaveLength(provider.catalogue.channels.length - separators.length);
    expect(all.some((channel) => channel.name.startsWith("#####"))).toBe(false);
    expect(categories[0]).toEqual({
      id: "1",
      name: "TEST | Streams and failures",
      group: null,
      title: "TEST | Streams and failures",
      channelCount: 8,
    });
    expect(categories[1]).toMatchObject({ group: "United Kingdom", title: "Entertainment" });
    expect(onUpdated).toHaveBeenCalledWith({
      channelCount: all.length,
      fetchedAt: expect.any(Number),
    });
  });

  it("normalises the provider's loose fields", async () => {
    const { library } = await connectedLibrary();

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
    ]);
  });

  it("serves the cached catalogue after a restart without the provider", async () => {
    const { provider, create, library } = await connectedLibrary();
    const before = await library.channels({});
    await provider.close();

    const restarted = create();

    expect(await restarted.channels({})).toEqual(before);
    expect((await restarted.status()).channelCount).toBe(before.length);
  });

  it("reports a missing channel", async () => {
    const { library } = await connectedLibrary();

    await expect(library.channel("does-not-exist")).rejects.toMatchObject({
      error: { kind: "channel-not-found", channelId: "does-not-exist" },
    });
  });
});
