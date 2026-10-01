import { afterEach, describe, expect, it, vi } from "vitest";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { startFakeTmdb, type FakeTmdb } from "./fake-tmdb.ts";
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

  it("fetches nothing without a key", async () => {
    const app = await metadataApp(null);
    const { onDemand } = await app.start();
    expect((await onDemand.status()).metadata).toBeNull();
    expect(app.tmdb.detailRequests()).toBe(0);
  });
});
