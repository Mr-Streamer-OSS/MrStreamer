import { describe, expect, it } from "vitest";
import * as Layer from "effect/Layer";
import { ViewingStore } from "@mrstreamer/core/viewing/service";
import { databaseLayer } from "../src/main/platform/database.ts";
import { VerifiedFiles, verifiedFilesLayer } from "../src/main/platform/verified-files.ts";
import { viewingStoreLayer } from "../src/main/platform/viewing-store.ts";
import { watchlistStoreLayer } from "../src/main/platform/watchlist-store.ts";
import { promised, runtimeFor, tempDir } from "./support.ts";

describe("verified file tracks", () => {
  it("keeps each file separate across restart, rejects old source facts and erases with viewing", async () => {
    const dir = await tempDir();
    const layer = () =>
      Layer.mergeAll(verifiedFilesLayer, viewingStoreLayer, watchlistStoreLayer).pipe(
        Layer.provide(databaseLayer(dir)),
      );
    const first = runtimeFor(layer());
    const tracks = await promised(first, VerifiedFiles);
    await tracks.remember("account", "saved-login", {
      kind: "movie",
      id: "hd",
      fileKey: "file-hd",
      listingKey: "listed-hd",
      audio: ["eng"],
      subtitles: [],
    });
    await tracks.remember("account", "saved-login", {
      kind: "episode",
      id: "4k",
      seriesId: "series",
      fileKey: "file-4k",
      listingKey: "listed-4k",
      audio: ["nld", null],
      subtitles: ["fra"],
    });
    await first.dispose();
    const second = runtimeFor(layer());
    const restored = await promised(second, VerifiedFiles);
    expect(await restored.read("account", "saved-login")).toEqual([
      {
        kind: "episode",
        id: "4k",
        seriesId: "series",
        fileKey: "file-4k",
        listingKey: "listed-4k",
        audio: ["nld", null],
        subtitles: ["fra"],
      },
      {
        kind: "movie",
        id: "hd",
        fileKey: "file-hd",
        listingKey: "listed-hd",
        audio: ["eng"],
        subtitles: [],
      },
    ]);
    expect(await restored.read("account", "new-login")).toEqual([]);
    await restored.remember("account", "saved-login", {
      kind: "movie",
      id: "hd",
      fileKey: "replacement",
      listingKey: "listed-hd",
      audio: ["deu"],
      subtitles: ["eng"],
    });
    await restored.forget(
      "account",
      { kind: "movie", subscriptionId: "saved", id: "hd" },
      "file-hd",
    );
    expect(
      (await restored.read("account", "saved-login")).find((file) => file.id === "hd")?.audio,
    ).toEqual(["deu"]);
    await restored.forget(
      "account",
      { kind: "movie", subscriptionId: "saved", id: "hd" },
      "replacement",
    );
    expect(await restored.read("account", "saved-login")).toHaveLength(1);
    const viewing = await promised(second, ViewingStore);
    await viewing.erase("account");
    expect(await restored.read("account", "saved-login")).toEqual([]);
    await second.dispose();
    const third = runtimeFor(layer());
    expect(await (await promised(third, VerifiedFiles)).read("account", "saved-login")).toEqual([]);
  });
});
