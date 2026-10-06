import { describe, expect, it } from "vitest";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { collect, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

/**
 * The app's movie and series service on a fake provider, restartable on the same data folder.
 * `own` names a title of the connected subscription by the provider's id. `reconnect` enters the
 * login again, as the viewer does to repair it: the subscription stays the same.
 */
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
  const reconnect = () =>
    app.subscriptions.connect({ server: provider.url, username: "demo", password: "demo" });
  const { id: subscriptionId } = await reconnect();
  const own = (id: string) => ({ subscriptionId, id });
  return { provider, dataDir, start, own, reconnect, ...app };
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

  it("keeps titles only their category marks for adults out when the categories come back empty", async () => {
    const { onDemand, provider } = await onDemandApp();
    const adultInAll = async () =>
      (
        await onDemand.collection({
          kind: "movie",
          id: "all",
          sort: "title",
          offset: 0,
          limit: 1000,
        })
      ).titles.some((title) => title.name.startsWith("Adult Film"));
    expect(await adultInAll()).toBe(false);

    provider.emptyTitleCategories(true);
    await onDemand.refresh();

    expect(await adultInAll()).toBe(false);
    expect((await onDemand.search("adult film")).movies).toEqual([]);
  });

  it("shows the episodes the provider added once the lists are refreshed", async () => {
    const { onDemand, provider, own } = await onDemandApp();
    const episodes = async () => {
      const details = await onDemand.details("series", own("80000"));
      return details.kind === "series" ? details.seasons.flatMap((season) => season.episodes) : [];
    };
    const before = await episodes();

    const series = provider.titles.series.find((each) => each.id === 80_000);
    const season = series?.seasons.at(-1);
    if (!series || !season?.[0]) throw new Error("The fake provider has no test series.");
    // The fake provider lists what its titles hold when asked.
    (season as unknown as unknown[]).push({ ...season[0], id: 81_012 });
    expect(await episodes()).toHaveLength(before.length);
    await onDemand.refresh();

    expect((await episodes()).map((episode) => episode.id)).toEqual([
      ...before.map((episode) => episode.id),
      "81012",
    ]);
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

  it("searches one kind for its page: the best matches, and how many match in all", async () => {
    const { onDemand } = await onDemandApp({ titles: 1000 });

    const stories = await onDemand.searchKind("movie", "story");
    expect(stories.titles).toHaveLength(300);
    expect(stories.total).toBeGreaterThan(300);
    expect(stories.titles.every((title) => title.kind === "movie" && !title.adult)).toBe(true);
    expect((await onDemand.searchKind("series", "sound test")).total).toBe(0);
    expect((await onDemand.searchKind("movie", "sound test")).titles.map((t) => t.title)).toEqual([
      "TEST | Two sound tracks and subtitles",
    ]);
  });

  it("finds titles by any version from the lists, without asking for details", async () => {
    const { onDemand, provider, own } = await onDemandApp();
    const versions = provider.titles.movies.slice(0, 3).map((movie) => own(String(movie.id)));

    const found = await onDemand.titles("movie", [...versions, own("404")]);

    // Each title, and each of its versions, says whose it is.
    expect(found.every((title) => title.subscriptionId === own("").subscriptionId)).toBe(true);
    expect(
      found.flatMap((title) => title.versions.map(({ tags: _tags, ...named }) => named)),
    ).toEqual(expect.arrayContaining(versions));
    expect(provider.detailRequests()).toBe(0);
    // Without TMDB, a title's details are the provider's.
    const [first] = versions;
    if (!first) throw new Error("The fake provider has no movies.");
    const details = await onDemand.details("movie", first);
    expect(details.cast).toEqual([
      { name: "Ada Lovelace", role: null, photoUrl: null },
      { name: "Alan Turing", role: null, photoUrl: null },
    ]);
    expect(provider.detailRequests()).toBe(1);
  });

  it("builds a series' seasons from its episodes when the provider lists fewer seasons", async () => {
    const { onDemand, own } = await onDemandApp();

    const details = await onDemand.details("series", own("80000"));

    expect(details.kind).toBe("series");
    if (details.kind !== "series") return;
    expect(details.seasons.map((season) => [season.name, season.episodes.length])).toEqual([
      ["Seizoen 1", 3],
      ["Season 2", 2],
    ]);
    expect(details.seasons[0]?.episodes[0]).toMatchObject({
      ...own("81000"),
      seriesId: "80000",
      season: 1,
      number: 1,
      title: "Part 1",
      duration: 2700,
    });
  });

  it("shows one row for an episode the provider lists twice, and still plays the other file", async () => {
    const { onDemand, own } = await onDemandApp();

    const details = await onDemand.details("series", own("80000"));

    if (details.kind !== "series") throw new Error("Not a series.");
    expect(details.seasons[0]?.episodes.map((episode) => [episode.id, episode.number])).toEqual([
      ["81000", 1],
      ["81001", 2],
      ["81002", 3],
    ]);
    const file = await onDemand.file({
      kind: "episode",
      ...own("81003"),
      seriesId: "80000",
      season: 1,
      episode: 2,
    });
    expect(file.container).toBe("mp4");
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

  it("drops lists that arrive after the login was entered again, and keeps the ones it had", async () => {
    const app = await onDemandApp();
    const { onDemand, provider } = app;
    await onDemand.refresh();
    const before = await onDemand.status();
    const told = await collect(app.runtime, onDemand.changes);
    const held = provider.hold("titles");
    const late = onDemand.refresh();
    late.catch(() => {});
    await held.arrived;

    const again = await app.reconnect();
    held.release();

    await expect(late).rejects.toMatchObject({ error: { kind: "unexpected" } });
    expect(app.own("").subscriptionId).toBe(again.id);
    expect(await onDemand.status()).toEqual(before);
    expect(told).toEqual([]);
    // Nor are they what the next start reads.
    await app.runtime.dispose();
    expect(await (await app.start()).onDemand.status()).toEqual(before);
  });

  it("doesn't report a refusal that arrives after the login was entered again", async () => {
    const app = await onDemandApp();
    const { onDemand, provider } = app;
    await onDemand.refresh();
    const before = await onDemand.status();
    const told = await collect(app.runtime, onDemand.changes);
    provider.failTitles("login");
    const held = provider.hold("titles");
    const late = onDemand.refresh();
    late.catch(() => {});
    await held.arrived;

    await app.reconnect();
    held.release();

    await expect(late).rejects.toMatchObject({ error: { kind: "invalid-login" } });
    expect(await onDemand.status()).toEqual(before);
    expect(told).toEqual([]);
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
    await expect(app.onDemand.season(app.own("80000"), 1)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });

  it("finds nothing by a version that names another subscription", async () => {
    const { onDemand, provider, own } = await onDemandApp();
    const id = String(provider.titles.movies[0]?.id);
    // The same provider id, as another subscription's lists could hold it.
    const theirs = { subscriptionId: "another-subscription", id };

    expect(await onDemand.titles("movie", [theirs])).toEqual([]);
    expect(await onDemand.titles("movie", [theirs, own(id)])).toHaveLength(1);
    for (const asked of [
      onDemand.details("movie", theirs),
      onDemand.season({ ...theirs, id: "80000" }, 1),
      onDemand.file({ kind: "movie", ...theirs }),
    ]) {
      await expect(asked).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    }
    expect(provider.detailRequests()).toBe(0);
    // Nor does a title like one of another subscription's lead a row.
    const rows = (like: typeof theirs) => onDemand.rows("movie", "for-you", like);
    expect((await rows(theirs)).some((row) => row.id.startsWith("like:"))).toBe(false);
  });
});
