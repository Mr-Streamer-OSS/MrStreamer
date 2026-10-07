import { afterEach, describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { startFakeTmdb, type FakeTmdb } from "./fake-tmdb.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

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
});
