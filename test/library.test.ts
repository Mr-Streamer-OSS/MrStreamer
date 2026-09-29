import { describe, expect, it, vi } from "vitest";
import { createLibrary } from "../src/main/services/library.ts";
import { createSubscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, tempDir, testSecrets, userAgent } from "./support.ts";

async function connectedLibrary(channels = 300) {
  const provider = await fakeProvider({ channels });
  const dataDir = await tempDir();
  const subscriptions = createSubscriptions({
    dataDir,
    secrets: testSecrets,
    providerOptions: { userAgent },
  });
  await subscriptions.connect({ server: provider.url, username: "demo", password: "demo" });
  const onUpdated = vi.fn();
  const create = () =>
    createLibrary({ dataDir, source: subscriptions.source, onUpdated, confirmDelayMs: 0 });
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
      name: "TEST | Formats and failures",
      group: null,
      title: "TEST | Formats and failures",
      channelCount: 10,
    });
    expect(categories[1]).toMatchObject({ group: "United Kingdom", title: "Entertainment" });
    expect(onUpdated).toHaveBeenCalledWith({
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

  it("serves the cached catalogue after a restart without the provider", async () => {
    const { provider, create, library } = await connectedLibrary();
    const before = await library.channels({});
    await provider.close();

    const restarted = create();

    expect(await restarted.channels({})).toEqual(before);
    expect((await restarted.status()).channelCount).toBe(before.length);
  });

  it("keeps the last catalogue when a refresh fails", async () => {
    const { provider, library, onUpdated } = await connectedLibrary();
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
    expect(onUpdated).toHaveBeenLastCalledWith(await library.status());

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

  it("reports a missing channel", async () => {
    const { library } = await connectedLibrary();

    await expect(library.channel("does-not-exist")).rejects.toMatchObject({
      error: { kind: "channel-not-found", channelId: "does-not-exist" },
    });
  });
});
