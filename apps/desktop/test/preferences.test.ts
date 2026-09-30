import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import { describe, expect, it } from "vitest";
import { createPreferences } from "../src/main/services/preferences.ts";
import { ipcInputs } from "@mrstreamer/contracts/ipc";
import { tempDir } from "./support.ts";

describe("preferences", () => {
  it("changes only what the UI sends, and survives a restart", async () => {
    const dataDir = await tempDir();
    await createPreferences(dataDir).update({ lastChannelId: "818", lastCategoryId: "7" });

    const patch = ipcInputs["preferences.update"]({ volume: 0.3, muted: true });
    if (patch instanceof type.errors) throw new Error(patch.summary);
    await createPreferences(dataDir).update(patch);

    expect(await createPreferences(dataDir).get()).toEqual({
      volume: 0.3,
      muted: true,
      lastChannelId: "818",
      lastCategoryId: "7",
    });
  });

  it("forgets what was watched last, but not the volume, when the subscription changes", async () => {
    const preferences = createPreferences(await tempDir());
    await preferences.update({ volume: 0.4, lastChannelId: "818", lastCategoryId: "7" });

    expect(await preferences.forget()).toMatchObject({
      volume: 0.4,
      lastChannelId: null,
      lastCategoryId: null,
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

    expect(await createPreferences(dataDir).get()).toEqual({
      volume: 0.3,
      muted: true,
      lastChannelId: "5",
      lastCategoryId: null,
    });
  });
});
