import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tmdb as tmdbClient } from "@mrstreamer/core/metadata/tmdb";
import { metadataStore, type Wanted } from "../src/main/ondemand/metadata.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { startFakeTmdb, tmdbName, type FakeTmdb } from "./fake-tmdb.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

let tmdb: FakeTmdb | null = null;
afterEach(async () => {
  await tmdb?.close();
  tmdb = null;
});

/** The app with a TMDB key, against the fake provider and a fake TMDB. */
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
  await subscriptions.connect({ server: provider.url, username: "demo", password: "demo" });
  await runtime.dispose();
  return { start, tmdb: tmdb };
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

  it("shows TMDB's overview, artwork and credits in a title's details once it opens", async () => {
    const app = await metadataApp();
    const { onDemand } = await app.start();
    const [movie] = (
      await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 50 })
    ).titles.filter((title) => title.tmdbId);
    expect(app.tmdb.aboutRequests()).toBe(0);

    const details = await onDemand.details("movie", movie?.id ?? "");

    expect(details.plot).toMatch(/^TMDB's story of /);
    expect(details.title.posterUrl).toBe(
      `https://image.tmdb.org/t/p/w780/poster-${movie?.tmdbId}.jpg`,
    );
    expect(details.cast).toEqual([
      {
        name: "Alan Actor",
        role: "The Lead",
        photoUrl: "https://image.tmdb.org/t/p/w185/alan.jpg",
      },
    ]);
    expect(details.directors).toEqual(["Grace Director"]);
    // The file's own length stands.
    expect(details.duration).toBe(6000);
    // Opening it again asks no one.
    await onDemand.details("movie", movie?.id ?? "");
    expect(app.tmdb.aboutRequests()).toBe(1);
  });

  it("fetches nothing without a key", async () => {
    const app = await metadataApp(null);
    const { onDemand } = await app.start();
    expect((await onDemand.status()).metadata).toBeNull();
    expect(app.tmdb.detailRequests()).toBe(0);
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
