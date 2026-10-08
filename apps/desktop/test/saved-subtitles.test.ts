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

    // An unkeyed different result starts on time.
    const next = { ...subtitle, service: "opensubtitles" as const, release: "Another release" };
    await restored.remember(file, next);
    expect(await restored.read(file)).toEqual({
      timing: { offset: 0, speed: 1 },
      subtitle: next,
    });
  });

  it("keeps a result the viewer turned off, with its cues and timing, until it is chosen again", async () => {
    const dir = await tempDir();
    const layer = () => savedSubtitlesLayer.pipe(Layer.provide(databaseLayer(dir)));
    const first = runtimeFor(layer());
    const saved = await promised(first, SavedSubtitles);
    // A row from before the mark existed has no key and no mark, and shows.
    await saved.remember(file, subtitle);
    expect(await saved.read(file)).toEqual({ timing: { offset: 0, speed: 1 }, subtitle });
    await saved.hide(file);
    await saved.timing(file, { offset: 2, speed: 1 });
    await saved.hide({ ...file, id: "hd" });
    await first.dispose();

    const restored = await promised(runtimeFor(layer()), SavedSubtitles);
    expect(await restored.read(file)).toEqual({
      shown: false,
      timing: { offset: 2, speed: 1 },
      subtitle,
    });
    expect(await restored.read({ ...file, id: "hd" })).toBeNull();
    for (const other of [
      { ...file, account: "another" },
      { ...file, sourceStamp: "changed-source" },
      { ...file, listingKey: "replacement" },
    ])
      expect(await restored.read(other)).toBeNull();
    await restored.show(file);
    expect(await restored.read(file)).toEqual({ timing: { offset: 2, speed: 1 }, subtitle });

    // A download replaces the selection and shows; the result before it stays cached by its key.
    const next = { ...subtitle, release: "Another release" };
    await restored.remember(file, subtitle, "first");
    await restored.timing(file, { offset: 1, speed: 25 / 23.976 }, "first");
    await restored.hide(file);
    await restored.remember(file, next, "second");
    expect(await restored.read(file)).toEqual({
      selection: "second",
      timing: { offset: 0, speed: 1 },
      subtitle: next,
    });
    await restored.hide(file);
    await restored.show(file, "first");
    expect(await restored.read(file)).toEqual({
      selection: "first",
      timing: { offset: 1, speed: 25 / 23.976 },
      subtitle,
    });
    expect(await restored.result(file, "second")).toEqual({
      selection: "second",
      timing: { offset: 0, speed: 1 },
      subtitle: next,
    });
    await expect(restored.show(file, "never-saved")).rejects.toBeDefined();
    expect((await restored.read(file))?.selection).toBe("first");
  });

  it.each(["listingKey", "sourceStamp"] as const)(
    "a changed %s clears obsolete results without letting an old forget erase its replacement",
    async (changed) => {
      const runtime = runtimeFor(
        savedSubtitlesLayer.pipe(Layer.provide(databaseLayer(await tempDir()))),
      );
      const saved = await promised(runtime, SavedSubtitles);
      await saved.timing(file, { offset: 21, speed: 25 / 24 });
      await saved.remember(file, subtitle, "old-result");
      const replacement = { ...file, [changed]: "new-file" };
      await saved.remember(replacement, subtitle, "new-result");
      expect(await saved.result(file, "old-result")).toBeNull();
      await saved.forget(file);
      expect(await saved.read(file)).toBeNull();
      expect(await saved.read(replacement)).toEqual({
        timing: { offset: 0, speed: 1 },
        subtitle,
        selection: "new-result",
      });
      expect((await saved.result(replacement, "new-result"))?.subtitle).toEqual(subtitle);
      await expect(saved.timing(replacement, { offset: 601, speed: 1 })).rejects.toBeDefined();
      await expect(
        saved.remember(replacement, {
          ...subtitle,
          cues: [{ start: 8, end: 4, text: "Backwards" }],
        }),
      ).rejects.toBeDefined();
      expect((await saved.read(replacement))?.timing).toEqual({ offset: 0, speed: 1 });
      await saved.forget(replacement);
      expect(await saved.result(replacement, "new-result")).toBeNull();
    },
  );

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

describe("bounded downloaded-result cache", () => {
  it("retains eight recent results, restores each correction and erases every cached result with its account", async () => {
    const dir = await tempDir();
    const runtime = runtimeFor(
      Layer.mergeAll(savedSubtitlesLayer, viewingStoreLayer, watchlistStoreLayer).pipe(
        Layer.provide(databaseLayer(dir)),
      ),
    );
    const saved = await promised(runtime, SavedSubtitles);
    for (let index = 0; index < 9; index++) {
      await saved.remember(file, { ...subtitle, release: `Cut ${index}` }, `result-${index}`);
      await saved.timing(file, { offset: index, speed: 1 });
    }
    expect(await saved.result(file, "result-0")).toBeNull();
    expect((await saved.result(file, "result-1"))?.timing.offset).toBe(1);
    const cached = (await saved.result(file, "result-1"))!;
    await saved.remember(file, cached.subtitle!, "result-1", cached.timing);
    await saved.remember(file, subtitle, "new-result");
    expect(await saved.result(file, "result-2")).toBeNull();
    expect((await saved.result(file, "result-1"))?.timing.offset).toBe(1);
    await (await promised(runtime, ViewingStore)).erase(file.account);
    expect(await saved.result(file, "result-1")).toBeNull();
    expect(await saved.read(file)).toBeNull();
    await runtime.dispose();
  });
});
