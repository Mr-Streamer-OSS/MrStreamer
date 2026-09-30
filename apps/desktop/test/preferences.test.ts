import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { describe, expect, it } from "vitest";
import { ipcInputs } from "@mrstreamer/contracts/ipc";
import { Settings } from "../src/main/services/preferences.ts";
import { promised, runtimeFor, tempDir } from "./support.ts";

/** Settings on `dataDir`, as a new start of the app reads them. */
const settingsIn = (dataDir: string) => promised(runtimeFor(Settings.layer(dataDir)), Settings);

describe("preferences", () => {
  it("changes only what the UI sends, and survives a restart", async () => {
    const dataDir = await tempDir();
    await (await settingsIn(dataDir)).update({ lastChannelId: "818", lastCategoryId: "7" });

    const patch = ipcInputs["preferences.update"]()({ volume: 0.3, muted: true });
    if (patch instanceof type.errors) throw new Error(patch.summary);
    await (await settingsIn(dataDir)).update(patch);

    expect(await (await settingsIn(dataDir)).get()).toEqual({
      volume: 0.3,
      muted: true,
      lastChannelId: "818",
      lastCategoryId: "7",
    });
  });

  it("forgets what was watched last, but not the volume, when the subscription changes", async () => {
    const preferences = await settingsIn(await tempDir());
    await preferences.update({ volume: 0.4, lastChannelId: "818", lastCategoryId: "7" });

    expect(await preferences.forget()).toMatchObject({
      volume: 0.4,
      lastChannelId: null,
      lastCategoryId: null,
    });
  });

  it("keeps what a newer version wrote when it saves", async () => {
    const dataDir = await tempDir();
    const newer = {
      volume: 1,
      muted: false,
      lastChannelId: null,
      lastCategoryId: null,
      subtitles: "nl",
    };
    await writeFile(join(dataDir, "preferences.json"), JSON.stringify(newer));

    await (await settingsIn(dataDir)).update({ volume: 0.5 });

    expect(JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8"))).toEqual({
      ...newer,
      volume: 0.5,
    });
  });

  it("reads files that still carry favourites and recent channels, without them", async () => {
    const dataDir = await tempDir();
    await writeFile(
      join(dataDir, "preferences.json"),
      JSON.stringify({
        volume: 0.3,
        muted: true,
        lastChannelId: "5",
        lastCategoryId: null,
        recentChannelIds: ["5"],
        favouriteChannelIds: ["5"],
      }),
    );

    expect(await (await settingsIn(dataDir)).get()).toEqual({
      volume: 0.3,
      muted: true,
      lastChannelId: "5",
      lastCategoryId: null,
    });
  });
});
