import { describe, expect, it } from "vitest";
import * as Layer from "effect/Layer";
import { ViewingStore } from "@mrstreamer/core/viewing/service";
import type { DownloadedSubtitle } from "@mrstreamer/contracts/online-subtitles";
import { databaseLayer } from "../src/main/platform/database.ts";
import {
  SavedSubtitles,
  savedSubtitlesLayer,
  type SubtitleFile,
} from "../src/main/platform/saved-subtitles.ts";
import { viewingStoreLayer } from "../src/main/platform/viewing-store.ts";
import { watchlistStoreLayer } from "../src/main/platform/watchlist-store.ts";
import { promised, runtimeFor, tempDir } from "./support.ts";

const file: SubtitleFile = {
  account: "account",
  sourceStamp: "saved-source",
  listingKey: "exact-4k-listing",
  kind: "movie",
  id: "4k",
};
const subtitle: DownloadedSubtitle = {
  service: "subdl",
  language: "en",
  release: "Night Harbour",
  cues: [{ start: 4, end: 6, text: "Good evening." }],
};

describe("saved exact-file subtitles", () => {
  it("restores downloaded cues and timing after restart without transferring to another file", async () => {
    const dir = await tempDir();
    const layer = () => savedSubtitlesLayer.pipe(Layer.provide(databaseLayer(dir)));
    const first = runtimeFor(layer());
    const saved = await promised(first, SavedSubtitles);
    await saved.timing(file, { offset: -480.1, speed: 24 / 25 });
    await saved.remember(file, subtitle);
    await first.dispose();

    const second = runtimeFor(layer());
    const restored = await promised(second, SavedSubtitles);
    expect(await restored.read(file)).toEqual({
      timing: { offset: -480.1, speed: 24 / 25 },
      subtitle,
    });
    for (const other of [
      { ...file, id: "hd" },
      { ...file, kind: "episode" as const },
      { ...file, account: "another" },
      { ...file, sourceStamp: "changed-source" },
      { ...file, listingKey: "replacement" },
    ])
      expect(await restored.read(other)).toBeNull();

    // Trying another result preserves this file's correction.
    const next = { ...subtitle, service: "opensubtitles" as const, release: "Another release" };
    await restored.remember(file, next);
    expect(await restored.read(file)).toEqual({
      timing: { offset: -480.1, speed: 24 / 25 },
      subtitle: next,
    });
  });

  it("a replaced listing starts at zero and an obsolete forget cannot erase its replacement", async () => {
    const runtime = runtimeFor(
      savedSubtitlesLayer.pipe(Layer.provide(databaseLayer(await tempDir()))),
    );
    const saved = await promised(runtime, SavedSubtitles);
    await saved.timing(file, { offset: 21, speed: 25 / 24 });
    await saved.remember(file, subtitle);
    const replacement = { ...file, listingKey: "new-file" };
    await saved.remember(replacement, subtitle);
    await saved.forget(file);
    expect(await saved.read(file)).toBeNull();
    expect(await saved.read(replacement)).toEqual({ timing: { offset: 0, speed: 1 }, subtitle });
    await expect(saved.timing(replacement, { offset: 601, speed: 1 })).rejects.toBeDefined();
    await expect(
      saved.remember(replacement, { ...subtitle, cues: [{ start: 8, end: 4, text: "Backwards" }] }),
    ).rejects.toBeDefined();
    expect((await saved.read(replacement))?.timing).toEqual({ offset: 0, speed: 1 });
  });

  it("account erasure removes cues and timing permanently while retaining other accounts", async () => {
    const dir = await tempDir();
    const layer = () =>
      Layer.mergeAll(savedSubtitlesLayer, viewingStoreLayer, watchlistStoreLayer).pipe(
        Layer.provide(databaseLayer(dir)),
      );
    const first = runtimeFor(layer());
    const saved = await promised(first, SavedSubtitles);
    const other = { ...file, account: "other" };
    await saved.remember(file, subtitle);
    await saved.remember(other, subtitle);
    await (await promised(first, ViewingStore)).erase(file.account);
    await first.dispose();
    const restarted = await promised(runtimeFor(layer()), SavedSubtitles);
    expect(await restarted.read(file)).toBeNull();
    expect((await restarted.read(other))?.subtitle).toEqual(subtitle);
  });
});
