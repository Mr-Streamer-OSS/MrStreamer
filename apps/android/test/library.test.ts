import type { Json } from "@mrstreamer/contracts/json";
import { describe, expect, it } from "vitest";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { indexCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import { collections } from "@mrstreamer/core/ondemand/collections";
import type { ProviderTitle } from "@mrstreamer/core/provider";
import { browseCollection } from "../src/library/browse.ts";
import { chosenVersion, versionMemory } from "../src/library/versions.ts";
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
    expect(f.model.tabs("movie")).toEqual(expect.arrayContaining(["for-you", "new", "4k", "all"]));
    expect(f.model.tabs("movie")).not.toContain("genres");
    expect(
      browseCollection(f.model.made("movie"), "all", { sort: "title", filters: {} }).sort,
    ).toBe("title");
    expect(f.model.search("movie", "Movie", 1).total).toBe(43);
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
      revision: () => 0,
      subscribe: () => () => {},
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
    let saved: Json = {};

    const storage = {
      readJson: () => saved,
      writeJson: (_: string, value: Json) => {
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
      revision: () => 0,
      subscribe: () => () => {},
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
});

it("protects ambiguous or invalid preference reads", () => {
  for (const raw of [[], "broken"]) {
    let writes = 0;

    const memory = versionMemory({
      readJson: () => raw,
      writeJson: () => {
        writes++;
      },
    });

    expect(() => memory.set("title", "version")).toThrow();
    expect(writes).toBe(0);
  }
});

it("shows TMDB facts even when the first provider details read fails", async () => {
  const f = fixture({ revision: () => 0, subscribe: () => () => {}, about: async () => about });
  await f.model.refresh();
  f.failDetails(true);
  const title = f.model.made("series").list("all")[0]!;
  expect(await f.model.details(title)).toMatchObject({
    providerFailed: true,
    value: { plot: "Saved TMDB story", seasons: [] },
  });
});

it("reuses collection metadata across searches until its revision or language changes", async () => {
  let reads = 0;
  let revision = 0;
  let language = "en";
  const { source } = fixture();
  const { libraryModel } = await import("../src/library/model.ts");

  const model = libraryModel({
    language: () => language,
    sources: () => [source],
    metadata: {
      subscribe: () => () => {},
      about: async () => about,
      revision: () => revision,
      facts: {
        get: () => {
          reads++;

          return null;
        },
        name: () => null,
        services: () => [],
      },
    },
  });

  await model.refresh();
  model.made("movie").list("all");
  const first = reads;
  expect(first).toBeGreaterThan(0);

  for (const query of ["M", "Mo", "Mov"]) {
    model.search("movie", query);
    model.made("movie").list("all");
  }

  expect(reads).toBe(first);
  revision++;
  model.made("movie").list("all");
  expect(reads).toBeGreaterThan(first);
  const revised = reads;
  language = "nl";
  model.made("movie").list("all");
  expect(reads).toBeGreaterThan(revised);
});

it("ignores unknown preference values without blocking valid choices or erasing them", () => {
  let saved: Json | undefined;

  const memory = versionMemory({
    readJson: () => ({ valid: "version", future: 42 }),
    writeJson: (_, value) => {
      saved = value;
    },
  });

  expect(memory.get("valid")).toBe("version");
  expect(memory.get("future")).toBeUndefined();
  memory.set("next", "choice");
  expect(saved).toEqual({ valid: "version", future: 42, next: "choice" });
});

it("persists and restores the first version choice on a fresh install", () => {
  let saved: Json = null;

  const storage = {
    readJson: () => saved,
    writeJson: (_name: string, value: Json) => {
      saved = value;
    },
  };

  const memory = versionMemory(storage);
  expect(memory.get("title")).toBeUndefined();
  memory.set("title", "version");
  expect(saved).toEqual({ title: "version" });
  expect(versionMemory(storage).get("title")).toBe("version");
});

it("expires rolling New collections as the clock advances", async () => {
  const { source } = fixture();
  let now = 1793700100000;
  const { libraryModel } = await import("../src/library/model.ts");
  const model = libraryModel({ sources: () => [source], language: () => "en", now: () => now });
  await model.refresh();
  expect(model.made("movie").list("new-week")).toHaveLength(43);
  now += 8 * 86400000;
  expect(model.made("movie").list("new-week")).toHaveLength(0);
  expect(model.made("movie").list("new-month")).toHaveLength(43);
  now += 31 * 86400000;
  expect(model.made("movie").list("new-month")).toHaveLength(0);
});

it("lets two open details calls finish with their provider and TMDB facts", async () => {
  let release!: () => void;

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const { source } = fixture();
  const { libraryModel } = await import("../src/library/model.ts");
  let reads = 0;

  const model = libraryModel({
    sources: () => [
      {
        ...source,
        details: async (...args) => {
          if (++reads > 1) throw new Error("Read superseded");
          await held;

          return source.details(...args);
        },
      },
    ],
    language: () => "en",
    metadata: { revision: () => 0, subscribe: () => () => {}, about: async () => about },
  });

  await model.refresh();
  const title = model.made("series").list("all")[0]!;
  const first = model.details(title);
  const second = model.details(title);
  release();

  for (const answer of await Promise.all([first, second])) {
    expect(answer.providerFailed).toBe(false);
    expect(answer.value?.plot).toBe("Saved TMDB story");
    expect(answer.value?.kind === "series" && answer.value.seasons.length).toBe(3);
  }
});

it("keeps loaded episodes after a failed provider retry", async () => {
  const f = fixture();
  await f.model.refresh();
  const title = f.model.made("series").list("all")[0]!;
  const first = await f.model.details(title);
  f.failDetails(true);
  const retry = await f.model.details(title);
  expect(retry.providerFailed).toBe(true);
  expect(retry.value).toEqual(first.value);
});

it.each(["throws", "invalid"])(
  "can save after a preferences read %s and then recovers",
  (failure) => {
    let raw: Json | undefined = failure === "invalid" ? [] : undefined;
    let writes = 0;

    const memory = versionMemory({
      readJson: () => {
        if (raw === undefined) throw new Error("Unavailable");

        return raw;
      },
      writeJson: (_, next) => {
        writes++;
        raw = next;
      },
    });

    expect(() => memory.set("title", "first")).toThrow();
    expect(writes).toBe(0);
    raw = { future: { kept: true } };
    memory.set("title", "second");
    expect(raw).toEqual({ future: { kept: true }, title: "second" });
    raw = null;
    memory.set("title", null);
    expect(raw).toEqual({});
  },
);
