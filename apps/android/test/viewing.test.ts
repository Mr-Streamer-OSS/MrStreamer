import { describe, expect, it } from "vitest";
import type { Json, JsonObject } from "@mrstreamer/contracts/json";
import { defined } from "@mrstreamer/core/defined";
import type { Sources } from "../src/connect/sources.ts";
import { libraryModel } from "../src/library/model.ts";
import { viewingOwner, titleRef } from "../src/home/viewing.ts";
import { homeModel, watchlistRows } from "../src/home/model.ts";
import { fixture } from "./library-fixture.ts";

/** Reaches into a saved JSON object so a test can damage one field; anything else fails the test. */
function object(value: Json | undefined): { [field: string]: Json | undefined } {
  if (!value || typeof value !== "object" || !isObject(value)) throw new Error("Not an object");

  return value;
}

const isObject = (value: Json): value is JsonObject => !Array.isArray(value);

function disk() {
  let value: Json = null;
  let refused = false;

  return {
    readJson: () => structuredClone(value),
    writeJson: (_: string, next: Json) => {
      if (refused) throw new Error("refused");
      value = structuredClone(next);
    },
    refuse: (on: boolean) => {
      refused = on;
    },
  };
}

async function setup() {
  const f = fixture();

  const model = libraryModel({
    sources: () => [{ ...f.source, reader: f.source }],
    language: () => "en",
  });

  await model.refresh();
  const platform = disk();
  let ids = ["source"];

  const make = () =>
    viewingOwner(
      platform,
      () => ids,
      () => model,
    );

  const owner = make();
  await owner.read();
  const title = model.made("movie").list("all", "title")[0]!;
  const series = model.made("series").list("all", "title")[0]!;

  return {
    ...f,
    model,
    owner,
    platform,
    make,
    title,
    series,
    owners: (next: string[]) => {
      ids = next;
    },
  };
}

describe("Android viewing persistence", () => {
  it("restores watchlist, recent channels, per-version progress and episode marks in a fresh owner", async () => {
    const f = await setup();

    try {
      await f.owner.setWatchlist(f.title, true);
      await f.owner.recordWatch({ sourceId: "source", channelId: "live" });
      await f.owner.recordProgress(
        { kind: "movie", subscriptionId: "source", id: f.title.id },
        300,
        1800,
        1,
      );
      await f.owner.markEpisode(
        {
          kind: "episode",
          subscriptionId: "source",
          seriesId: f.series.id,
          id: "first",
          season: 1,
          episode: 1,
        },
        true,
      );
      const restored = f.make();

      try {
        await restored.read();
        expect(restored.state.get().watchlist[0]?.name).toBe(f.title.title);
        expect(restored.state.get().viewing?.recent).toEqual([
          { subscriptionId: "source", id: "live" },
        ]);
        expect((await restored.progress(f.title))[0]?.position).toBe(300);
        expect((await restored.episodes(f.series)).marks).toHaveLength(1);
      } finally {
        await restored.dispose();
      }
    } finally {
      await f.owner.dispose();
    }
  });
  it("refuses writes without publishing changes and allows retry, including delete history", async () => {
    const f = await setup();

    try {
      await f.owner.setWatchlist(f.title, true);
      const before = f.owner.state.get();
      const saved = f.platform.readJson();
      f.platform.refuse(true);
      await expect(f.owner.removeWatchlist(before.watchlist[0]!)).rejects.toThrow();
      await expect(
        f.owner.recordProgress(
          { kind: "movie", subscriptionId: "source", id: f.title.id },
          300,
          1800,
          1,
        ),
      ).rejects.toThrow();
      await expect(
        f.owner.markEpisode(
          {
            kind: "episode",
            subscriptionId: "source",
            seriesId: f.series.id,
            id: "first",
            season: 1,
            episode: 1,
          },
          true,
        ),
      ).rejects.toThrow();
      await expect(f.owner.clear("source")).rejects.toThrow();
      expect(f.owner.state.get()).toEqual(before);
      expect(f.platform.readJson()).toEqual(saved);
      f.platform.refuse(false);
      await f.owner.clear("source");
      expect(f.owner.state.get().watchlist).toEqual([]);
    } finally {
      await f.owner.dispose();
    }
  });
  it("hides ordinary removal, restores re-add, and keeps history across password replacement", async () => {
    const f = await setup();

    try {
      await f.owner.setWatchlist(f.title, true);
      await f.owner.recordProgress(
        titleRef({
          kind: "movie",
          sourceId: "source",
          titleKey: f.title.key,
          titleId: f.title.id,
          version: f.title.versions[0]!,
        }),
        300,
        1800,
        1,
      );
      f.owners([]);
      await f.owner.refresh();
      expect(f.owner.state.get().watchlist).toEqual([]);
      expect(f.owner.state.get().viewing?.continueWatching).toEqual([]);
      f.owners(["source"]);
      await f.owner.refresh();
      expect(f.owner.state.get().watchlist).toHaveLength(1);
      // Signing in again keeps the same subscription identity.
      await f.model.refresh();
      await f.owner.refresh();
      expect((await f.owner.progress(f.title))[0]?.position).toBe(300);
    } finally {
      await f.owner.dispose();
    }
  });
  it("keeps an unreadable or interrupted file retryable instead of overwriting it as empty", async () => {
    const f = await setup();
    await f.owner.dispose();
    let failed = true;
    let writes = 0;

    const owner = viewingOwner(
      {
        readJson: () => {
          if (failed) throw new Error("interrupted");

          return null;
        },
        writeJson: () => {
          writes++;
        },
      },
      () => ["source"],
      () => f.model,
    );

    try {
      await owner.read();
      expect(owner.state.get().kind).toBe("failed");
      await expect(owner.setWatchlist(f.title, true)).rejects.toThrow();
      expect(writes).toBe(0);
      failed = false;
      await owner.read();
      await owner.setWatchlist(f.title, true);
      expect(owner.state.get().watchlist).toHaveLength(1);
    } finally {
      await owner.dispose();
    }
  });
  it("falls back to the provider's movies without ratings when there is no TMDB", async () => {
    const f = await setup();

    try {
      const sources: Sources = {
        kind: "ready",
        sources: [
          {
            id: "source",
            kind: "xtream",
            label: "Test provider",
            channels: { kind: "ready", rows: [] },
          },
        ],
      } as const;

      const home = homeModel(f.owner.state.get(), sources, f.model, undefined);
      expect(home.movies.length).toBeGreaterThan(0);
      expect(home.movies.every((t) => t.rating === null)).toBe(true);
    } finally {
      await f.owner.dispose();
    }
  });
  it("skips a version whose provider cannot sign in and reports why when none opens", async () => {
    const f = fixture();
    let first = true;
    let second = true;

    const model = libraryModel({
      sources: () => [
        {
          ...f.source,
          ...defined({ reader: first ? f.source : undefined }),
          needsLogin: !first,
          catalogue: () => (first ? f.source.catalogue() : Promise.reject(new Error("login"))),
        },
        {
          ...f.source,
          id: "other",
          label: "Other provider",
          ...defined({ reader: second ? f.source : undefined }),
          needsLogin: !second,
          catalogue: () => (second ? f.source.catalogue() : Promise.reject(new Error("login"))),
        },
      ],
      language: () => "en",
    });

    await model.refresh();

    let ids = ["source", "other"];

    const owner = viewingOwner(
      disk(),
      () => ids,
      () => model,
    );

    const sources: Sources = {
      kind: "ready",
      sources: ["source", "other"].map((id) => ({
        id,
        label: id === "source" ? "Test provider" : "Other provider",
        kind: "xtream",
        channels: { kind: "ready", rows: [] },
      })),
    } as const;

    try {
      await owner.read();
      const title = model.made("movie").list("all", "title")[0]!;
      await owner.setWatchlist(title, true);
      await owner.recordProgress(
        { kind: "movie", subscriptionId: "source", id: title.id },
        300,
        1800,
        1,
      );
      first = false;
      await model.refresh();
      const home = homeModel(owner.state.get(), sources, model, undefined);
      expect(home.continuing[0]?.version.subscriptionId).toBe("other");
      expect(home.continuing[0]?.progress).toBe(null);
      expect(home.watchlist[0]?.why).toBe(null);
      second = false;
      await model.refresh();
      expect(homeModel(owner.state.get(), sources, model, undefined).continuing).toEqual([]);
      expect(watchlistRows(owner.state.get(), sources, model)[0]?.why).toBe("needs-secret");
      first = true;
      second = true;
      await model.refresh();
      ids = ["other"];
      await owner.refresh();
      const other = title.versions.find((version) => version.subscriptionId === "other")!;
      await owner.setWatchlist({ ...title, ...other }, true);
      ids = ["source", "other"];
      await owner.refresh();
      expect(watchlistRows(owner.state.get(), sources, model)).toHaveLength(1);
      const removed = await owner.removeWatchlist(owner.state.get().watchlist[0]!);
      expect(removed).toHaveLength(2);
      expect(owner.state.get().watchlist).toHaveLength(0);
      await owner.restoreWatchlist(removed);
      expect(watchlistRows(owner.state.get(), sources, model)).toHaveLength(1);
    } finally {
      await owner.dispose();
    }
  });
});

it("retries a malformed snapshot after the persisted file is repaired", async () => {
  const f = await setup();

  try {
    await f.owner.recordProgress(
      { kind: "movie", subscriptionId: "source", id: f.title.id },
      300,
      1800,
      1,
    );
    const valid = f.platform.readJson();
    const malformed = structuredClone(valid);
    const source = object(object(object(malformed).record).accounts).source;

    delete object(source).rows;
    f.platform.writeJson("viewing.json", malformed);
    await f.owner.read();
    expect(f.owner.state.get().kind).toBe("failed");
    expect(f.platform.readJson()).toEqual(malformed);
    f.platform.writeJson("viewing.json", valid);
    await f.owner.read();
    expect(f.owner.state.get().kind).toBe("ready");
    expect((await f.owner.progress(f.title))[0]?.position).toBe(300);
  } finally {
    await f.owner.dispose();
  }
});
