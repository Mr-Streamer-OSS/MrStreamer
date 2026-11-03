import { describe, expect, it } from "vitest";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { indexCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import { collections } from "@mrstreamer/core/ondemand/collections";
import type { ProviderTitle } from "@mrstreamer/core/provider";
import { browseCollection } from "../src/library/browse.ts";
import { chosenVersion, versionMemory } from "../src/library/versions.ts";
import { intentRegistry, type PlayIntent } from "../src/library/intents.ts";
import { about, fixture } from "./library-fixture.ts";

function versions() {
  const row = (id: string, name: string): ProviderTitle => ({
    id,
    name,
    tmdbId: "1",
    posterUrl: null,
    backdropUrl: null,
    adult: false,
    rating: 8,
    addedAt: 1,
    releaseDate: null,
    categoryIds: [],
    container: "mp4",
  });

  const index = indexCatalogue(
    [
      {
        subscriptionId: "source",
        catalogue: {
          movies: [row("en", "Alpha HD (EN)"), row("nl", "Alpha 4K (NL)")],
          series: [],
          movieCategories: [],
          seriesCategories: [],
        },
      },
    ],
    "en",
  );

  const made = collections({
    kind: "movie",
    titles: index.movies.titles,
    language: "en",
    metadata: () => null,
    names: () => null,
    services: [],
    now: 1,
  });

  return { made, title: index.movies.titles[0]! };
}

describe("Android library public behavior", () => {
  it("pages searches, preserves stale lists on failure, retries, and removes revoked sources", async () => {
    const f = fixture();
    await f.model.refresh();
    expect(f.requests).toContain("get_vod_streams");
    expect(f.model.tabs("movie")).toEqual(expect.arrayContaining(["for-you", "new", "4k", "all"]));
    expect(f.model.tabs("movie")).not.toContain("genres");
    expect(
      browseCollection(f.model.made("movie"), "all", { sort: "title", filters: {} }).sort,
    ).toBe("title");
    expect(f.model.search("movie", "Movie", 1)).toMatchObject({
      total: 43,
      titles: expect.any(Array),
    });
    expect(f.model.search("movie", "Movie", 1).titles).toHaveLength(20);
    expect(f.model.search("movie", "Movie", 2).titles).toHaveLength(40);
    expect(f.model.search("movie", "Movie", 3).titles).toHaveLength(43);
    f.fail(true);
    await f.model.refresh();
    expect(f.model.state.get().failures).toEqual(["Test provider"]);
    expect(f.model.made("movie").size("all")).toBe(43);
    f.fail(false);
    await f.model.refresh();
    expect(f.model.state.get().failures).toEqual([]);
    f.remove();
    await f.model.refresh();
    expect(f.model.made("movie").size("all")).toBe(0);
  });

  it("shows metadata genres and services only when those collections contain listed titles", async () => {
    const f = fixture({
      about: async () => about,
      facts: {
        get: () => ({
          genres: [18],
          language: "en",
          popularity: 20,
          rating: 8,
          votes: 200,
          collection: null,
          backdrop: null,
        }),
        name: () => null,
        services: () => [{ id: 1, name: "Test service", priority: 1, ids: new Set(["10"]) }],
      },
    });

    await f.model.refresh();
    expect(f.model.tabs("movie")).toEqual(expect.arrayContaining(["genres", "services"]));
    expect(f.model.made("movie").list("genre:Drama")).toHaveLength(43);
    expect(f.model.made("movie").list("service:1")).toHaveLength(1);
  });

  it("requires one eligible file for combined hints and never invents known tracks", () => {
    const { made, title } = versions();
    expect(
      browseCollection(made, "all", { filters: { quality: "4k", language: "en" } }).titles,
    ).toHaveLength(0);
    const matching = browseCollection(made, "all", { filters: { quality: "4k", language: "nl" } });
    expect(matching.titles[0]?.id).toBe("nl");
    expect(matching.total).toBe(1);
    expect(browseCollection(made, "4k", { filters: { language: "en" } }).titles).toHaveLength(0);

    const files = new Map([
      [
        ownedKey(title.versions[0]!),
        [{ tags: ["HD", "EN"], tracks: { audio: ["en"], subtitles: [] } }],
      ],
    ]);

    const known = browseCollection(made, "all", { filters: {} }, files);
    expect(known.verified).toEqual([{ value: { kind: "audio", language: "en" }, count: 1 }]);
    expect(
      browseCollection(
        made,
        "all",
        { filters: { quality: "4k", verified: { kind: "audio", language: "en" } } },
        files,
      ).titles,
    ).toHaveLength(0);
    expect(browseCollection(made, "all", { filters: {} }).titles).toHaveLength(1);
  });

  it("uses manual, requested, remembered and automatic choices in iOS order, with honest save failures", () => {
    const { title } = versions();
    const en = ownedKey(title.versions.find((v) => v.id === "en")!);
    const nl = ownedKey(title.versions.find((v) => v.id === "nl")!);
    expect(chosenVersion(title, { manual: en, requested: nl, remembered: nl }).id).toBe("en");
    expect(chosenVersion(title, { requested: nl, remembered: en }).id).toBe("nl");
    expect(chosenVersion(title, { remembered: nl }).id).toBe("nl");
    expect(chosenVersion(title, { manual: null, requested: nl }).id).toBe(title.id);
    expect(chosenVersion(title, { manual: "removed", remembered: nl }).id).toBe("nl");
    let refused = false;
    let saved: unknown = null;

    const storage = {
      readJson: () => saved,
      writeJson: (_: string, value: unknown) => {
        if (refused) throw new Error("Read only");
        saved = value;
      },
    };

    const memory = versionMemory(storage);
    memory.set(title.key, nl);
    expect(versionMemory(storage).get(title.key)).toBe(nl);
    refused = true;
    expect(() => memory.set(title.key, en)).toThrow();
    expect(memory.get(title.key)).toBe(nl);
  });

  it("keeps provider and saved TMDB facts on failure and orders Specials last", async () => {
    let failed = false;

    const f = fixture({
      about: async () => {
        if (failed) throw new Error("Offline");

        return about;
      },
    });

    await f.model.refresh();
    const title = f.model.made("series").list("all")[0]!;
    const first = await f.model.details(title);
    expect(first.value?.plot).toBe("Saved TMDB story");
    expect(first.value?.kind === "series" && first.value.seasons.map((s) => s.number)).toEqual([
      1, 2, 0,
    ]);
    failed = true;
    f.failDetails(true);
    const stale = await f.model.details(title);
    expect(stale).toMatchObject({
      metadataFailed: true,
      providerFailed: true,
      value: { plot: "Saved TMDB story" },
    });
    failed = false;
    f.failDetails(false);
    expect(await f.model.details(title)).toMatchObject({
      metadataFailed: false,
      providerFailed: false,
    });
    const without = fixture();
    await without.model.refresh();
    expect(await without.model.details(without.model.made("movie").list("all")[0]!)).toMatchObject({
      metadataFailed: false,
      value: { plot: "Provider story" },
    });
  });

  it("hands later owners a stable intent only while a handler is registered", () => {
    const registry = intentRegistry();
    const { title } = versions();
    expect(registry.state.get()).toEqual({});
    const received: PlayIntent[] = [];
    const stop = registry.register({ play: (intent) => received.push(intent) });
    registry.state.get().play?.({
      action: "play",
      media: {
        sourceId: title.subscriptionId,
        kind: "movie",
        titleId: title.id,
        titleKey: title.key,
        version: chosenVersion(title, {}),
      },
    });
    expect(received[0]?.media).toMatchObject({
      sourceId: "source",
      titleKey: title.key,
      titleId: title.id,
      version: { id: title.id },
    });
    const stopDownload = registry.register({ download: () => {} });
    expect(registry.state.get().play).toBeDefined();
    stop();
    expect(registry.state.get().play).toBeUndefined();
    expect(registry.state.get().download).toBeDefined();
    stopDownload();
    expect(registry.state.get()).toEqual({});
  });
});
