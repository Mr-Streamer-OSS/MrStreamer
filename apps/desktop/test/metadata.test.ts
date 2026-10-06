import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { ownedId, ownedKey } from "@mrstreamer/contracts/subscription";
import { tmdb as tmdbClient } from "@mrstreamer/core/metadata/tmdb";
import { metadataStore, type Wanted } from "../src/main/ondemand/metadata.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { startFakeTmdb, tmdbName, type FakeTmdb } from "./fake-tmdb.ts";
import {
  collect,
  fakeProvider,
  promised,
  runtimeFor,
  tempDir,
  testConfig,
  type Promised,
} from "./support.ts";

let tmdb: FakeTmdb | null = null;
afterEach(async () => {
  await tmdb?.close();
  tmdb = null;
});

/** A movie of the lists that TMDB knows. */
async function knownMovie(onDemand: Promised<OnDemand["Service"]>): Promise<Title> {
  const { titles } = await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 50 });
  const movie = titles.find((title) => title.tmdbId);
  if (!movie) throw new Error("The lists have no movie with a TMDB id.");
  return movie;
}

/**
 * The app with a TMDB key, against the fake provider and a fake TMDB. `own` names a title of the
 * connected subscription by the provider's id.
 */
async function metadataApp(key: string | null = "test-key") {
  tmdb = await startFakeTmdb();
  const dataDir = await tempDir();
  const provider = await fakeProvider();
  const start = async () => {
    const runtime = runtimeFor(
      mainLayer({ ...testConfig(dataDir), tmdbKey: key, tmdbApi: tmdb?.url ?? "" }),
    );
    const onDemand = await promised(runtime, OnDemand);
    // Any list loads the catalogue, and with it the metadata.
    await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 10 });
    return { runtime, onDemand };
  };
  const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  const subscriptions = await promised(runtime, Subscriptions);
  const { id: subscriptionId } = await subscriptions.connect({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  await runtime.dispose();
  const own = (id: string) => ({ subscriptionId, id });
  return { start, tmdb: tmdb, own };
}

describe("TMDB metadata", { timeout: 30_000 }, () => {
  it("asks TMDB about each listed title once, and keeps what it said across restarts", async () => {
    const app = await metadataApp();
    const first = await app.start();
    await vi.waitFor(
      async () => {
        const { metadata } = await first.onDemand.status();
        expect(metadata?.wanted).toBeGreaterThan(0);
        expect(metadata?.known).toBe(metadata?.wanted);
      },
      { timeout: 20_000 },
    );
    const asked = app.tmdb.detailRequests();
    expect(asked).toBe((await first.onDemand.status()).metadata?.wanted);
    await first.runtime.dispose();

    const again = await app.start();
    const { metadata } = await again.onDemand.status();
    expect(metadata?.known).toBe(metadata?.wanted);
    expect(app.tmdb.detailRequests()).toBe(asked);
  });

  it("asks TMDB about titles for adults only while Settings shows them", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    const asked = async (wanted: number) =>
      vi.waitFor(
        async () => {
          const { metadata } = await onDemand.status();
          expect(metadata).toMatchObject({ wanted, known: wanted });
        },
        { timeout: 20_000 },
      );
    await vi.waitFor(async () =>
      expect((await onDemand.status()).metadata?.wanted).toBeGreaterThan(0),
    );
    const ordinary = (await onDemand.status()).metadata?.wanted ?? 0;
    await asked(ordinary);
    expect(app.tmdb.detailRequests()).toBe(ordinary);

    await (await promised(runtime, Settings)).update({ adultTitles: true });
    const forAdults = (
      await Promise.all(
        (["movie", "series"] as const).map((kind) =>
          onDemand.collection({ kind, id: "adult", offset: 0, limit: 1000 }),
        ),
      )
    ).flatMap((page) => page.titles.filter((title) => title.tmdbId));
    expect(forAdults.length).toBeGreaterThan(0);
    await asked(ordinary + forAdults.length);
    expect(app.tmdb.detailRequests()).toBe(ordinary + forAdults.length);
  });

  it("stops asking when TMDB refuses the key, and says so", async () => {
    const app = await metadataApp();
    app.tmdb.refuse(true);
    const { onDemand } = await app.start();
    await vi.waitFor(async () =>
      expect((await onDemand.status()).metadata).toMatchObject({ known: 0, refused: true }),
    );
  });

  it("builds genres, streaming services and rows from it, in the viewer's language", async () => {
    const app = await metadataApp();
    // Netflix streams the first generated films; their TMDB ids are their ids plus 10,000.
    app.tmdb.stream(
      "movie",
      Array.from({ length: 30 }, (_, index) => String(101_000 + index)),
    );
    const { onDemand } = await app.start();
    await vi.waitFor(
      async () => expect(await onDemand.tiles("movie", "services")).not.toEqual([]),
      { timeout: 25_000 },
    );

    const genres = await onDemand.tiles("movie", "genres");
    expect(genres.map((genre) => genre.name).sort()).toEqual(["Comedy", "Drama"]);
    const comedy = await onDemand.collection({
      kind: "movie",
      id: "genre:Comedy",
      offset: 0,
      limit: 500,
    });
    expect(comedy.titles.length).toBeGreaterThan(0);
    expect(comedy.titles.every((title) => title.genres.includes("Comedy"))).toBe(true);

    // Films made in Dutch with only a Dutch version: out of the English rows, but in All.
    const all = await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 500 });
    const dutch = all.titles.filter(
      (title) => Number(title.tmdbId) % 3 === 0 && title.tags.includes("NL"),
    );
    expect(dutch.length).toBeGreaterThan(0);
    const shown = new Set(
      [
        ...comedy.titles,
        ...(await onDemand.collection({ kind: "movie", id: "genre:Drama", offset: 0, limit: 500 }))
          .titles,
      ].map((title) => title.id),
    );
    expect(dutch.some((title) => shown.has(title.id))).toBe(false);

    const services = await onDemand.tiles("movie", "services");
    expect(services).toEqual([expect.objectContaining({ name: "Netflix" })]);
    const rows = await onDemand.rows("movie", "for-you");
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(["Popular", "Netflix"]));

    // For you leads with titles like one watched lately, named by one of its versions.
    const [watched] = comedy.titles;
    if (!watched) throw new Error("No comedy to be like.");
    const [alike] = await onDemand.rows("movie", "for-you", ownedId(watched));
    expect(alike).toMatchObject({
      id: `like:${ownedKey(watched)}`,
      name: `More like ${watched.title}`,
    });
    expect(alike?.titles.some((title) => title.id === watched.id)).toBe(false);
    const page = await onDemand.collection({
      kind: "movie",
      id: `like:${ownedKey(watched)}`,
      offset: 0,
      limit: 5,
    });
    expect(page.titles).toEqual(alike?.titles.slice(0, 5));
  });

  it("shows TMDB's names in the viewer's language, and finds titles by their original name", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    const settings = await promised(runtime, Settings);
    const done = () =>
      vi.waitFor(
        async () => {
          const { metadata } = await onDemand.status();
          expect(metadata?.known).toBe(metadata?.wanted);
        },
        { timeout: 20_000 },
      );
    /** What a title shows, by TMDB's rules as the fake TMDB plays them. */
    const expected = (tmdbId: string, language: string) => {
      const id = Number(tmdbId);
      const shown = tmdbName(id, language);
      const madeIn = id % 3 === 0 ? "nl" : "en";
      // Without a translation, the English name stands in; for an English film, its own.
      const name =
        shown.name !== shown.original || madeIn === language
          ? shown.name
          : madeIn === "en"
            ? shown.original
            : tmdbName(id, "en").name;
      return {
        title: name,
        originalTitle: name === shown.original ? null : shown.original,
        // Which sound "Original language" plays.
        originalLanguage: madeIn,
      };
    };
    const all = async () =>
      (await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 500 })).titles;

    // Lists take up what arrived with the store's next notice.
    const named = (language: string) =>
      vi.waitFor(
        async () => {
          const titles = (await all()).filter((title) => title.tmdbId);
          expect(titles.length).toBeGreaterThan(0);
          for (const title of titles) {
            expect(title).toMatchObject(expected(title.tmdbId ?? "", language));
          }
          return titles;
        },
        { timeout: 20_000 },
      );
    await done();
    const english = await named("en");
    // A Dutch film shown by its English name is found by its Dutch one.
    const dutch = english.find((title) => title.originalTitle?.startsWith("Origineel"));
    expect(dutch).toBeDefined();
    expect(
      (await onDemand.search(dutch?.originalTitle ?? "")).movies.map((title) => title.tmdbId),
    ).toContain(dutch?.tmdbId);

    // Dutch names come in the background; English ones stay known.
    const asked = app.tmdb.detailRequests();
    await settings.update({ titleLanguage: "nl" });
    await all();
    await done();
    await named("nl");
    expect(app.tmdb.detailRequests("nl")).toBe(app.tmdb.detailRequests() - asked);
    const both = app.tmdb.detailRequests();
    await settings.update({ titleLanguage: "en" });
    await named("en");
    expect(app.tmdb.detailRequests()).toBe(both);
  });

  it("gives a title's details without waiting for TMDB, and says when TMDB's arrive", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    const movie = await knownMovie(onDemand);
    expect(app.tmdb.aboutRequests()).toBe(0);
    const changed = await collect(runtime, onDemand.detailsChanged);
    app.tmdb.holdAbout(true);

    const early = await onDemand.details("movie", movie);

    expect(early.plot).toMatch(/^The story of /);
    await vi.waitFor(() => expect(app.tmdb.aboutRequests()).toBe(1));
    app.tmdb.holdAbout(false);
    await vi.waitFor(() => expect(changed).toEqual([{ kind: "movie", ...ownedId(movie) }]));
    const details = await onDemand.details("movie", movie);
    expect(details.plot).toMatch(/^TMDB's story of /);
    expect(details.title.posterUrl).toBe(
      `https://image.tmdb.org/t/p/w780/poster-${movie.tmdbId}.jpg`,
    );
    expect(details.cast).toEqual([
      {
        name: "Alan Actor",
        role: "The Lead",
        photoUrl: "https://image.tmdb.org/t/p/w185/alan.jpg",
      },
    ]);
    expect(details.directors).toEqual(["Grace Director"]);
    // TMDB's 101 minutes, not the provider's 100.
    expect(details.duration).toBe(6060);
    // Opening it again asks no one.
    await onDemand.details("movie", movie);
    expect(app.tmdb.aboutRequests()).toBe(1);
  });

  it("asks TMDB again for details it couldn't answer, or had no key for", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    const movie = await knownMovie(onDemand);
    const plot = async () => (await onDemand.details("movie", movie)).plot;

    app.tmdb.refuse(true);
    expect(await plot()).toMatch(/^The story of /);
    app.tmdb.refuse(false);
    await vi.waitFor(async () => expect(await plot()).toMatch(/^TMDB's story of /));

    const keyless = await metadataApp(null);
    const second = await keyless.start();
    const other = await knownMovie(second.onDemand);
    const otherPlot = async () => (await second.onDemand.details("movie", other)).plot;
    expect(await otherPlot()).toMatch(/^The story of /);
    await (await promised(second.runtime, Settings)).update({ tmdbKey: "own-key" });
    await second.onDemand.reconfigure();
    await vi.waitFor(async () => expect(await otherPlot()).toMatch(/^TMDB's story of /));
    await runtime.dispose();
  });

  it("puts details opened early together again with the names TMDB gives later", async () => {
    const app = await metadataApp();
    // TMDB refuses at first, so the lists and the details have only the provider's names.
    app.tmdb.refuse(true);
    const { runtime, onDemand } = await app.start();
    const movie = await knownMovie(onDemand);
    const early = await onDemand.details("movie", movie);
    expect(early.title).toMatchObject({ title: movie.title, originalLanguage: null });
    // Refused too.
    await vi.waitFor(() => expect(app.tmdb.aboutRequests()).toBe(1));

    // A key TMDB accepts: names arrive in the lists, in the background.
    app.tmdb.refuse(false);
    const settings = await promised(runtime, Settings);
    await settings.update({ tmdbKey: "another-key" });
    await onDemand.reconfigure();
    const listed = await vi.waitFor(
      async () => {
        const [title] = await onDemand.titles("movie", [movie]);
        expect(title?.originalLanguage).not.toBeNull();
        return title;
      },
      { timeout: 20_000 },
    );
    const downloads = app.tmdb.aboutRequests();

    // TMDB didn't answer then, so it is asked once more, now that it does.
    const again = await vi.waitFor(async () => {
      const details = await onDemand.details("movie", movie);
      expect(details.plot).toMatch(/^TMDB's story of /);
      return details;
    });

    expect(again.title).toMatchObject({
      title: listed?.title,
      originalLanguage: listed?.originalLanguage,
    });
    expect(app.tmdb.aboutRequests()).toBe(downloads + 1);
  });

  it("fetches nothing without a key", async () => {
    const app = await metadataApp(null);
    const { onDemand } = await app.start();
    expect((await onDemand.status()).metadata).toBeNull();
    expect(app.tmdb.detailRequests()).toBe(0);
    // A season's episodes are the provider's.
    const episodes = await onDemand.season(app.own(SERIES), 1);
    expect(episodes.map((episode) => episode.title)).toEqual(["Part 1", "Part 2", "Part 3"]);
    expect(app.tmdb.seasonRequests()).toEqual([]);
  });
});

/**
 * "TEST | Formats (NL)": three episodes in its first season and two in its second on the provider;
 * on TMDB, 90000, made in Dutch, four in its first and one in its second.
 */
const SERIES = "80000";

describe("episode details", { timeout: 30_000 }, () => {
  it("asks TMDB about a season only once it opens, for the episodes the provider has", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    await (await promised(runtime, Settings)).update({ titleLanguage: "nl" });
    const details = await onDemand.details("series", app.own(SERIES));
    if (details.kind !== "series") throw new Error("Not a series.");
    expect(app.tmdb.seasonRequests()).toEqual([]);

    const first = await onDemand.season(app.own(SERIES), 1);

    expect(app.tmdb.seasonRequests()).toEqual(["90000/1/nl"]);
    // The provider's three, not TMDB's fourth.
    expect(first.map((episode) => episode.id)).toEqual(
      details.seasons[0]?.episodes.map((episode) => episode.id),
    );
    expect(first[0]).toEqual({
      ...details.seasons[0]?.episodes[0],
      title: "Origineel 1x1",
      plot: "TMDB's story of Origineel 1x1.",
      stillUrl: "https://image.tmdb.org/t/p/w780/still-90000-1-1.jpg",
      airDate: "2020-01-01",
      // TMDB's 50 minutes, not the provider's 45.
      duration: 3000,
      rating: 8.2,
      cast: [
        {
          name: "Gus Guest",
          role: "The Visitor",
          photoUrl: "https://image.tmdb.org/t/p/w185/gus.jpg",
        },
      ],
      directors: ["Dora Director"],
    });
    // Four people rated the third: too few to show.
    expect(first.map((episode) => episode.rating)).toEqual([8.2, 8.2, null]);

    // Opened again, it asks no one; the second season asks once it opens.
    await onDemand.season(app.own(SERIES), 1);
    const second = await onDemand.season(app.own(SERIES), 2);
    expect(app.tmdb.seasonRequests()).toEqual(["90000/1/nl", "90000/2/nl"]);
    // TMDB lists one episode there; the provider's other keeps its own details.
    expect(second.map((episode) => [episode.title, episode.rating])).toEqual([
      ["Origineel 2x1", 8.2],
      ["Part 2", null],
    ]);
  });

  it("names episodes in the viewer's language, else in English, else in the series' own", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    const settings = await promised(runtime, Settings);
    await settings.update({ titleLanguage: "de" });

    const episodes = await onDemand.season(app.own(SERIES), 1);

    // TMDB names none in German, the odd ones in English, and all in Dutch, the series' own.
    expect(episodes.map((episode) => [episode.title, episode.plot])).toEqual([
      ["English 1x1", "TMDB's story of English 1x1."],
      ["Origineel 1x2", "TMDB's story of Origineel 1x2."],
      ["English 1x3", "TMDB's story of English 1x3."],
    ]);
    expect(app.tmdb.seasonRequests()).toEqual(["90000/1/de", "90000/1/en", "90000/1/nl"]);

    // In English, what TMDB said in English and Dutch serves again.
    await settings.update({ titleLanguage: "en" });
    const english = await onDemand.season(app.own(SERIES), 1);
    expect(english.map((episode) => episode.title)).toEqual([
      "English 1x1",
      "Origineel 1x2",
      "English 1x3",
    ]);
    expect(app.tmdb.seasonRequests()).toHaveLength(3);
  });

  it("gives each version of a series its own episodes, from the same answers", async () => {
    const app = await metadataApp();
    const { onDemand } = await app.start();

    const dutch = await onDemand.season(app.own(SERIES), 1);
    const english = await onDemand.season(app.own("79998"), 1);

    expect(dutch.map((episode) => [episode.id, episode.title])).toEqual([
      ["81000", "English 1x1"],
      ["81001", "Origineel 1x2"],
      ["81002", "English 1x3"],
    ]);
    expect(english.map((episode) => [episode.id, episode.title])).toEqual([
      ["799980", "English 1x1"],
      ["799981", "Origineel 1x2"],
    ]);
    expect(app.tmdb.seasonRequests()).toEqual(["90000/1/en", "90000/1/nl"]);
  });

  it("keeps the provider's episodes while TMDB fails or is slow, and asks again later", async () => {
    const app = await metadataApp();
    const { onDemand } = await app.start();
    const titles = async () =>
      (await onDemand.season(app.own(SERIES), 1)).map((episode) => episode.title);

    app.tmdb.failSeasons(500);
    expect(await titles()).toEqual(["Part 1", "Part 2", "Part 3"]);
    app.tmdb.failSeasons("hold");
    const started = Date.now();
    const slow = titles();
    // Playing an episode doesn't wait for it.
    await onDemand.file({
      kind: "episode",
      ...app.own("81000"),
      seriesId: SERIES,
      season: 1,
      episode: 1,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await slow).toEqual(["Part 1", "Part 2", "Part 3"]);
    expect(Date.now() - started).toBeLessThan(6000);

    app.tmdb.failSeasons(null);
    expect(await titles()).toEqual(["English 1x1", "Origineel 1x2", "English 1x3"]);
    expect(app.tmdb.seasonRequests()).toEqual([
      "90000/1/en",
      "90000/1/en",
      "90000/1/en",
      "90000/1/nl",
    ]);
  });
});

describe("TMDB metadata store", { timeout: 30_000 }, () => {
  const titles = (from: number, count: number): Wanted[] =>
    Array.from({ length: count }, (_, index) => ({
      kind: "movie",
      tmdbId: String(from + index),
      addedAt: from + index,
    }));

  it("fetches a list given while an earlier one is being fetched", async () => {
    tmdb = await startFakeTmdb();
    const store = metadataStore({
      path: join(await tempDir(), "metadata.json.gz"),
      client: tmdbClient({ key: "test-key", api: tmdb.url }),
      region: "NL",
      onChange: () => {},
    });
    store.want(titles(1, 40));
    await vi.waitFor(() => expect(tmdb?.detailRequests()).toBeGreaterThan(0));
    // As after a refresh that lists 20 more.
    store.want(titles(1, 60));
    await vi.waitFor(
      () => expect(store.status()).toMatchObject({ known: 60, wanted: 60, fetching: false }),
      { timeout: 20_000 },
    );
  });

  it("says it stopped when TMDB can't be reached, with titles still unanswered", async () => {
    const changes: boolean[] = [];
    const store = metadataStore({
      path: join(await tempDir(), "metadata.json.gz"),
      client: tmdbClient({ key: "test-key", api: "http://127.0.0.1:9/3" }),
      region: "NL",
      onChange: () => changes.push(store.status().fetching),
    });
    store.want(titles(1, 3));
    expect(store.status().fetching).toBe(true);
    await vi.waitFor(() => expect(store.status()).toMatchObject({ known: 0, fetching: false }), {
      timeout: 20_000,
    });
    // The UI hears that it stopped.
    expect(changes.at(-1)).toBe(false);
  });

  it("leaves out what TMDB said more than six months ago", async () => {
    const path = join(await tempDir(), "metadata.json.gz");
    const day = 86_400_000;
    const entry = (at: number) => ({ at, genres: [35], language: "en", popularity: 1 });
    await writeFile(
      path,
      gzipSync(
        JSON.stringify({
          version: 1,
          entries: { "movie:1": entry(0), "movie:2": entry(100 * day) },
        }),
      ),
    );
    const store = metadataStore({
      path,
      client: null,
      region: "NL",
      onChange: () => {},
      now: () => 200 * day,
    });
    store.want(titles(1, 2));
    await vi.waitFor(() => expect(store.get("movie", "2")).not.toBeNull());
    expect(store.get("movie", "1")).toBeNull();
  });
});
