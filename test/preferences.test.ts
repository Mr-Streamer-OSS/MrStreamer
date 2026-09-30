import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { describe, expect, it } from "vitest";
import { createPreferences } from "../src/main/services/preferences.ts";
import { ipcInputs } from "../src/shared/ipc.ts";
import { tempDir } from "./support.ts";

describe("preferences", () => {
  it("keeps recently watched channels newest first, without repeats, up to twelve", async () => {
    const preferences = createPreferences(await tempDir());

    for (const id of ["a", "b", "c", "a"]) await preferences.recordWatch(id);
    for (let index = 0; index < 20; index++) await preferences.recordWatch(`x${index}`);
    const latest = await preferences.recordWatch("b");

    expect(latest.lastChannelId).toBe("b");
    expect(latest.recentChannelIds).toHaveLength(12);
    expect(latest.recentChannelIds.slice(0, 3)).toEqual(["b", "x19", "x18"]);
    expect(new Set(latest.recentChannelIds).size).toBe(12);
  });

  it("keeps the recently watched and favourite lists when the UI changes the volume", async () => {
    const preferences = createPreferences(await tempDir());
    await preferences.recordWatch("818");
    await preferences.toggleFavourite("818");

    const patch = ipcInputs["preferences.update"]({ volume: 0.3, muted: false });
    if (patch instanceof type.errors) throw new Error(patch.summary);
    const updated = await preferences.update(patch);

    expect(updated).toMatchObject({
      volume: 0.3,
      lastChannelId: "818",
      recentChannelIds: ["818"],
      favouriteChannelIds: ["818"],
    });
  });

  it("keeps favourites in the order they were added, across restarts", async () => {
    const dataDir = await tempDir();
    const preferences = createPreferences(dataDir);

    for (const id of ["a", "b", "c", "b", "d"]) await preferences.toggleFavourite(id);

    expect((await createPreferences(dataDir).get()).favouriteChannelIds).toEqual(["a", "c", "d"]);
  });

  it("forgets history and favourites, but not the volume, when the subscription changes", async () => {
    const preferences = createPreferences(await tempDir());
    await preferences.update({ volume: 0.4, lastCategoryId: "7" });
    await preferences.recordWatch("818");
    await preferences.toggleFavourite("818");

    expect(await preferences.forget()).toMatchObject({
      volume: 0.4,
      lastChannelId: null,
      lastCategoryId: null,
      recentChannelIds: [],
      favouriteChannelIds: [],
    });
  });

  it("survives a restart", async () => {
    const dataDir = await tempDir();
    await createPreferences(dataDir).update({ volume: 0.4 });
    await createPreferences(dataDir).recordWatch("818");

    expect(await createPreferences(dataDir).get()).toMatchObject({
      volume: 0.4,
      lastChannelId: "818",
      recentChannelIds: ["818"],
    });
  });

  it("reads files saved before the recent and favourite lists existed", async () => {
    const dataDir = await tempDir();
    await writeFile(
      join(dataDir, "preferences.json"),
      JSON.stringify({ volume: 0.3, muted: true, lastChannelId: "5", lastCategoryId: null }),
    );

    expect(await createPreferences(dataDir).get()).toEqual({
      volume: 0.3,
      muted: true,
      lastChannelId: "5",
      lastCategoryId: null,
      recentChannelIds: [],
      favouriteChannelIds: [],
    });
  });
});
