import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import * as Layer from "effect/Layer";
import { ViewingStore } from "@mrstreamer/core/viewing/service";
import { databaseLayer } from "../src/main/platform/database.ts";
import {
  DetailCache,
  detailCacheLayer,
  type DetailKey,
  type DetailRecord,
} from "../src/main/platform/detail-cache.ts";
import { viewingStoreLayer } from "../src/main/platform/viewing-store.ts";
import { watchlistStoreLayer } from "../src/main/platform/watchlist-store.ts";
import { promised, runtimeFor, tempDir } from "./support.ts";

const providerKey = {
  kind: "provider",
  account: "account",
  subscriptionId: "saved",
  sourceStamp: "saved-login",
  titleKind: "series",
  id: "123",
} satisfies DetailKey;
const provider = {
  kind: "provider",
  at: 100,
  catalogueStamp: "accepted-catalogue",
  value: {
    originalName: "Series",
    plot: null,
    genres: [],
    cast: [],
    directors: [],
    releaseDate: null,
    duration: null,
    posterUrl: null,
    backdropUrl: null,
    seasons: [],
    episodes: [],
    container: null,
  },
} satisfies DetailRecord;

async function started(dir: string) {
  const runtime = runtimeFor(
    Layer.mergeAll(detailCacheLayer, viewingStoreLayer, watchlistStoreLayer).pipe(
      Layer.provide(databaseLayer(dir)),
    ),
  );
  return {
    runtime,
    cache: await promised(runtime, DetailCache),
    viewing: await promised(runtime, ViewingStore),
  };
}

describe("opened title detail storage", () => {
  it("restores only the same source and keeps shared language records through account erasure", async () => {
    const dir = await tempDir();
    const first = await started(dir);
    const about = { kind: "about", titleKind: "series", id: "123", language: "en" } as const;
    const missing = { kind: "about", at: 100, value: null } as const;
    await first.cache.remember(providerKey, provider);
    await first.cache.remember(about, missing);
    await first.runtime.dispose();
    const second = await started(dir);
    expect(await second.cache.read(providerKey)).toMatchObject(provider);
    expect(await second.cache.read({ ...providerKey, account: "other" })).toBeNull();
    expect(await second.cache.read({ ...providerKey, sourceStamp: "new-login" })).toBeNull();
    expect(await second.cache.read({ ...providerKey, importRevision: "new-mapping" })).toBeNull();
    expect(await second.cache.read({ ...about, language: "nl" })).toBeNull();
    await second.viewing.erase("account");
    expect(await second.cache.read(providerKey)).toBeNull();
    expect(await second.cache.read(about)).toMatchObject(missing);
    await second.cache.remember(providerKey, provider);
    await second.cache.forget("saved");
    expect(await second.cache.read(providerKey)).toBeNull();
  });

  it("treats corrupt and unknown disk formats as misses without breaking later writes", async () => {
    const dir = await tempDir();
    const { cache } = await started(dir);
    await cache.remember(providerKey, provider);
    const disk = new DatabaseSync(join(dir, "mrstreamer.db"));
    try {
      for (const payload of [
        "{",
        '{"schema":2,"kind":"provider"}',
        '{"schema":1,"kind":"provider","value":{}}',
      ]) {
        disk.prepare("update title_detail_cache set payload = ?").run(payload);
        expect(await cache.read(providerKey)).toBeNull();
      }
    } finally {
      disk.close();
    }
    await cache.remember(providerKey, provider);
    expect(await cache.read(providerKey)).toMatchObject(provider);
  });

  it("bounds tiny missing answers and leaves huge uncached details usable by their caller", async () => {
    const { cache } = await started(await tempDir());
    for (let id = 0; id < 2050; id++)
      await cache.remember(
        { kind: "season", id: String(id), number: 1, language: "en" },
        { kind: "season", at: 100, value: null },
      );
    expect(await cache.read({ kind: "season", id: "0", number: 1, language: "en" })).toBeNull();
    expect(
      await cache.read({ kind: "season", id: "2049", number: 1, language: "en" }),
    ).toMatchObject({ value: null });
    await cache.remember(providerKey, {
      ...provider,
      value: { ...provider.value, plot: "x".repeat(9 * 1024 * 1024) },
    });
    expect(await cache.read(providerKey)).toBeNull();
    await cache.remember(providerKey, provider);
    expect(await cache.read(providerKey)).toMatchObject(provider);
  });
});
