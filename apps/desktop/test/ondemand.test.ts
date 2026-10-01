import { describe, expect, it } from "vitest";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Settings } from "../src/main/services/preferences.ts";
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
    const settings = await promised(runtime, Settings);
    return { runtime, subscriptions, onDemand, settings };
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

  it("lists titles for adults on their own, once the viewer asks for them", async () => {
    const { onDemand, settings } = await onDemandApp();
    const adult = () => onDemand.collection({ kind: "movie", id: "adult", offset: 0, limit: 100 });
    expect((await adult()).total).toBe(0);

    await settings.update({ adultTitles: true });
    const listed = await adult();
    expect(listed.total).toBeGreaterThan(0);
    expect(listed.titles.every((title) => title.adult)).toBe(true);
    // Still nowhere else.
    expect((await onDemand.search("adult film")).movies).toEqual([]);
  });

  it("keeps series marked for adults out of everything else, whatever their category", async () => {
    const { onDemand, settings } = await onDemandApp();
    const series = (id: "all" | "adult") =>
      onDemand.collection({ kind: "series", id, sort: "title", offset: 0, limit: 1000 });

    expect((await series("all")).titles.map((title) => title.title)).not.toContain("After Dark");
    expect((await onDemand.search("after dark")).series).toEqual([]);

    await settings.update({ adultTitles: true });
    expect((await series("adult")).titles.map((title) => title.title)).toEqual(["After Dark"]);
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

  it("finds titles by any version's id from the lists, without asking for details", async () => {
    const { onDemand, provider } = await onDemandApp();
    const versions = provider.titles.movies.slice(0, 3).map((movie) => String(movie.id));

    const found = await onDemand.titles("movie", [...versions, "404"]);

    expect(found.map((title) => title.versions.map((version) => version.id)).flat()).toEqual(
      expect.arrayContaining(versions),
    );
    expect(provider.detailRequests()).toBe(0);
    // Without TMDB, a title's details are the provider's.
    const details = await onDemand.details("movie", versions[0] ?? "");
    expect(details.cast).toEqual([
      { name: "Ada Lovelace", role: null, photoUrl: null },
      { name: "Alan Turing", role: null, photoUrl: null },
    ]);
    expect(provider.detailRequests()).toBe(1);
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

  it("keeps the lists when the provider refuses the login for them", async () => {
    const { onDemand, provider } = await onDemandApp();
    await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 1 });
    const before = await onDemand.status();
    provider.failTitles("login");

    // Twice: a second empty answer in a row would count as the provider's real lists.
    for (const _ of [1, 2]) {
      await expect(onDemand.refresh()).rejects.toMatchObject({ error: { kind: "invalid-login" } });
    }

    expect(await onDemand.status()).toMatchObject({
      movies: before.movies,
      series: before.series,
      failure: { kind: "invalid-login" },
    });
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
