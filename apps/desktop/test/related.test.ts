import { createServer } from "node:http";
import { playlistGroupId } from "@mrstreamer/core/playlist/import";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { startFakeTmdb, type FakeTmdb } from "./fake-tmdb.ts";
import { collect, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

let tmdb: FakeTmdb | null = null;
afterEach(async () => {
  await tmdb?.close();
  tmdb = null;
});

describe("related titles from available subscriptions", { timeout: 20_000 }, () => {
  it("does not fetch unopened lists or details, caps matches and removes a forgotten owner's titles", async () => {
    const dataDir = await tempDir();
    const provider = await fakeProvider({ titles: 60 });
    const unopened = await fakeProvider({ second: true });
    const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
    const subscriptions = await promised(runtime, Subscriptions);
    const service = await promised(runtime, OnDemand);
    const roster = await promised(runtime, Roster);
    const add = (server: string) =>
      subscriptions.add({ server, username: "demo", password: "demo" });
    const own = await add(provider.url);
    await add(unopened.url);
    const version = { subscriptionId: own.id, id: "90000" };
    expect(await service.related("movie", version)).toEqual({ basis: null, titles: [] });
    expect(provider.titleListRequests()).toBe(0);
    expect(unopened.titleListRequests()).toBe(0);

    await service.refresh(own.id);
    const before = provider.titleListRequests();
    const found = await service.related("movie", version);
    expect(found.titles.length).toBeGreaterThan(0);
    expect(found.titles.length).toBeLessThanOrEqual(12);
    expect(
      found.titles.every(
        ({ title }) => title.subscriptionId === own.id && title.id !== version.id && !title.adult,
      ),
    ).toBe(true);
    expect(found.basis).toBe("Same category");
    expect(provider.titleListRequests()).toBe(before);
    expect(unopened.titleListRequests()).toBe(0);
    expect(provider.detailRequests()).toBe(0);
    expect(provider.fileRequests()).toBe(0);

    await roster.remove(own.id, false);
    expect(await service.related("movie", version)).toEqual({ basis: null, titles: [] });
    expect(unopened.titleListRequests()).toBe(0);
  });

  it("uses known TMDB facts across owners without asking TMDB or providers for more", async () => {
    tmdb = await startFakeTmdb();
    const dataDir = await tempDir();
    const provider = await fakeProvider({ titles: 24 });
    const other = await fakeProvider({ titles: 24, second: true });
    const runtime = runtimeFor(
      mainLayer({ ...testConfig(dataDir), tmdbKey: "fixture-key", tmdbApi: tmdb.url }),
    );
    const subscriptions = await promised(runtime, Subscriptions);
    const service = await promised(runtime, OnDemand);
    const add = (server: string) =>
      subscriptions.add({ server, username: "demo", password: "demo" });
    const own = await add(provider.url);
    const second = await add(other.url);
    await service.refresh(own.id);
    await service.refresh(second.id);
    await vi.waitFor(
      async () => {
        const { metadata } = await service.status();
        expect(metadata?.wanted).toBeGreaterThan(0);
        expect(metadata).toMatchObject({ known: metadata?.wanted, fetching: false });
      },
      { timeout: 10_000 },
    );
    const requests = tmdb.detailRequests();
    const listRequests = [provider.titleListRequests(), other.titleListRequests()];
    const found = await service.related("movie", { subscriptionId: own.id, id: "90000" });
    expect(found.titles.length).toBeGreaterThan(0);
    expect(found.titles.every(({ title }) => title.genres.length > 0)).toBe(true);
    expect(
      found.titles.some(({ title }) =>
        title.versions.some((each) => each.subscriptionId === second.id),
      ),
    ).toBe(true);
    expect(found.basis).not.toBe("Same category");
    expect(tmdb.detailRequests()).toBe(requests);
    expect(tmdb.aboutRequests()).toBe(0);
    expect([provider.titleListRequests(), other.titleListRequests()]).toEqual(listRequests);
    expect(provider.detailRequests() + other.detailRequests()).toBe(0);
    expect(provider.fileRequests() + other.fileRequests()).toBe(0);
  });
  it("uses lazy details' cached TMDB genres without new playlist, provider, TMDB or file requests", async () => {
    tmdb = await startFakeTmdb();
    tmdb.holdAbout(true);
    let playlistRequests = 0;
    let fileRequests = 0;
    const server = createServer((request, response) => {
      if (request.url !== "/list") {
        fileRequests++;
        return response.writeHead(404).end();
      }
      playlistRequests++;
      response.end(`#EXTM3U
#EXTINF:-1 group-title="Films" tmdb-id="42",Quiet Harbour
http://127.0.0.1/movie.mp4
#EXTINF:-1 group-title="Films",Harbour Lights
http://127.0.0.1/neighbour.mp4
`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const provider = await fakeProvider({ titles: 24 });
      const runtime = runtimeFor(
        mainLayer({
          ...testConfig(await tempDir()),
          tmdbKey: "fixture-key",
          tmdbApi: tmdb.url,
        }),
      );
      const subscriptions = await promised(runtime, Subscriptions);
      const service = await promised(runtime, OnDemand);
      const roster = await promised(runtime, Roster);
      const own = await subscriptions.add({
        server: `http://127.0.0.1:${address.port}/list`,
        username: "",
        password: "",
      });
      await subscriptions.mapPlaylist(own.id, playlistGroupId("Films"), "movie");
      const other = await subscriptions.add({
        server: provider.url,
        username: "demo",
        password: "demo",
      });
      await roster.refreshPlaylist(own.id);
      await service.refresh(other.id);
      await vi.waitFor(
        async () => {
          const { metadata } = await service.status();
          expect(metadata?.wanted).toBeGreaterThan(0);
          expect(metadata).toMatchObject({ known: metadata?.wanted, fetching: false });
        },
        { timeout: 10_000 },
      );
      const opened = (
        await service.collection({ kind: "movie", id: "all", offset: 0, limit: 100 })
      ).titles.find((title) => title.subscriptionId === own.id && title.tmdbId === "42")!;
      expect(opened.genres).toEqual([]);
      expect((await service.related("movie", opened)).basis).toBe("Same category");
      expect(tmdb.aboutRequests()).toBe(0);
      const changed = await collect(runtime, service.detailsChanged);
      const details = await service.details("movie", opened);
      expect(details.plot).toBeNull();
      await vi.waitFor(() => expect(tmdb?.aboutRequests()).toBe(1));
      tmdb.holdAbout(false);
      await vi.waitFor(() =>
        expect(changed).toContainEqual({
          kind: "movie",
          subscriptionId: own.id,
          id: opened.id,
        }),
      );
      const requests = [
        playlistRequests,
        provider.titleListRequests(),
        provider.detailRequests(),
        provider.fileRequests(),
        tmdb.detailRequests(),
        tmdb.aboutRequests(),
        fileRequests,
      ];
      const found = await service.related("movie", opened);
      expect(found.basis).toBe("Drama · Dutch");
      expect(
        found.titles.some(
          ({ title, reason }) => title.subscriptionId === other.id && reason === "Drama · Dutch",
        ),
      ).toBe(true);
      expect(await service.related("movie", opened)).toEqual(found);
      expect([
        playlistRequests,
        provider.titleListRequests(),
        provider.detailRequests(),
        provider.fileRequests(),
        tmdb.detailRequests(),
        tmdb.aboutRequests(),
        fileRequests,
      ]).toEqual(requests);
      expect(provider.detailRequests() + provider.fileRequests() + fileRequests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reuses available fallback facts and follows raw-list replacement after refresh", async () => {
    const provider = await fakeProvider({ titles: 24 });
    const runtime = runtimeFor(mainLayer(testConfig(await tempDir())));
    const subscriptions = await promised(runtime, Subscriptions);
    const service = await promised(runtime, OnDemand);
    const own = await subscriptions.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    const rows = provider.titles.movies;
    const set = (match: number) =>
      provider.serveTitles(() => ({
        ...provider.titles,
        movies: rows.map((row) => ({
          ...row,
          categoryId: String(row.id),
          name:
            row.id === 90000
              ? "Quiet Harbour"
              : row.id === match
                ? "Harbour Lights"
                : `Desert ${row.id}`,
        })),
      }));
    set(90001);
    await service.refresh(own.id);
    const version = { subscriptionId: own.id, id: "90000" };
    const first = await service.related("movie", version);
    expect(first.titles.map(({ title, reason }) => [title.id, reason])).toEqual([
      ["90001", "Similar name"],
    ]);
    const requests = provider.titleListRequests();
    expect(await service.related("movie", version)).toEqual(first);
    expect(provider.titleListRequests()).toBe(requests);
    set(90002);
    await service.refresh(own.id);
    expect(
      (await service.related("movie", version)).titles.map(({ title, reason }) => [
        title.id,
        reason,
      ]),
    ).toEqual([["90002", "Similar name"]]);
    expect(provider.detailRequests() + provider.fileRequests()).toBe(0);
  });
});
