import { describe, expect, it } from "vitest";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

/** The app's movie and series service on a fake provider, restartable on the same data folder. */
async function onDemandApp(options: { titles?: number } = {}) {
  const dataDir = await tempDir();
  const provider = await fakeProvider(options);
  const start = async () => {
    const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    const subscriptions = await promised(runtime, Subscriptions);
    const onDemand = await promised(runtime, OnDemand);
    return { runtime, subscriptions, onDemand };
  };
  const app = await start();
  await app.subscriptions.connect({ server: provider.url, username: "demo", password: "demo" });
  return { provider, dataDir, start, ...app };
}

// Each test starts the catalogue's worker thread, which takes a moment under a busy suite.
describe("movies and series", { timeout: 20_000 }, () => {
  it("fetches both lists on first use and lists them newest first, without adult titles", async () => {
    const { onDemand } = await onDemandApp();

    const newest = await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 5 });

    expect(newest.titles.map((title) => title.title)).toEqual([
      "TEST | Two sound tracks and subtitles",
      "TEST | Index at the end",
      "TEST | Old AVI",
      "TEST | Missing file",
      expect.any(String),
    ]);
    expect(newest.titles[0]).toMatchObject({ kind: "movie", tags: ["MULTI"], adult: false });
    const all = await onDemand.collection({
      kind: "movie",
      id: "all",
      sort: "title",
      offset: 0,
      limit: 1000,
    });
    expect(all.titles.some((title) => title.adult)).toBe(false);
    expect(all.total).toBe(all.titles.length);
    expect((await onDemand.status()).movies).toBeGreaterThan(all.total);
    expect((await onDemand.search("adult film")).movies).toEqual([]);
  });

  it("searches movies and series by any words of their names", async () => {
    const { onDemand } = await onDemandApp();

    const found = await onDemand.search("sound test");

    expect(found.movies.map((title) => title.title)).toEqual([
      "TEST | Two sound tracks and subtitles",
    ]);
    expect((await onDemand.search("formats")).series.map((title) => title.title)).toEqual([
      "TEST | Formats",
    ]);
  });

  it("builds a series' seasons from its episodes when the provider lists fewer seasons", async () => {
    const { onDemand } = await onDemandApp();

    const details = await onDemand.details("series", "80000");

    expect(details.kind).toBe("series");
    if (details.kind !== "series") return;
    expect(details.seasons.map((season) => [season.name, season.episodes.length])).toEqual([
      ["Seizoen 1", 3],
      ["Season 2", 2],
    ]);
    expect(details.seasons[0]?.episodes[0]).toMatchObject({
      seriesId: "80000",
      season: 1,
      number: 1,
      title: "Part 1",
      duration: 2700,
    });
  });

  it("keeps the lists after a restart without asking the provider again", async () => {
    const app = await onDemandApp();
    const before = await app.onDemand.collection({
      kind: "series",
      id: "all",
      offset: 0,
      limit: 10,
    });
    await app.runtime.dispose();
    app.provider.failTitles(500);

    const restarted = await app.start();

    expect(
      await restarted.onDemand.collection({ kind: "series", id: "all", offset: 0, limit: 10 }),
    ).toEqual(before);
    expect(await restarted.onDemand.isStale("12 hours")).toBe(false);
  });

  it("keeps the lists when a refresh fails, and says why", async () => {
    const { onDemand, provider } = await onDemandApp();
    const before = await onDemand.status();
    await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 1 });
    provider.failTitles(503);

    await expect(onDemand.refresh()).rejects.toMatchObject({
      error: { kind: "provider-error", status: 503 },
    });

    const after = await onDemand.status();
    expect(after.movies).toBeGreaterThan(before.movies);
    expect(after.failure).toEqual({ kind: "provider-error", status: 503 });
  });

  it("doesn't ask the provider again for every list after the first fetch failed", async () => {
    const { onDemand, provider } = await onDemandApp();
    const list = () => onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 1 });
    const failed = { error: { kind: "provider-error", status: 503 } };
    provider.failTitles(503);
    await expect(list()).rejects.toMatchObject(failed);

    // Lists answer with the failure for a while; refreshing asks again.
    provider.failTitles(null);
    await expect(list()).rejects.toMatchObject(failed);
    await onDemand.refresh();
    expect((await list()).total).toBeGreaterThan(0);
  });

  it("forgets the last account's titles when the subscription goes", async () => {
    const app = await onDemandApp();
    await app.onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 1 });

    await app.subscriptions.remove();
    await app.onDemand.clear();

    expect(await app.onDemand.status()).toEqual({
      movies: 0,
      series: 0,
      fetchedAt: null,
      failure: null,
      metadata: null,
    });
    await expect(app.onDemand.search("story")).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });
});
