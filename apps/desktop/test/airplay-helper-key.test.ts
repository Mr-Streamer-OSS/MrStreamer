import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Release builds cache the AirPlay helper under the key the build script prints. The key needs a
// Mac's compiler and SDK, so this runs on a Mac and is skipped elsewhere.
describe.skipIf(process.platform !== "darwin")("the AirPlay helper's cache key", () => {
  const copy = mkdtempSync(join(tmpdir(), "airplay-key-"));
  const desktop = join(import.meta.dirname, "..");
  cpSync(
    join(desktop, "scripts/build-airplay-helper.sh"),
    join(copy, "scripts/build-airplay-helper.sh"),
    {
      recursive: true,
    },
  );
  cpSync(join(desktop, "native/airplay"), join(copy, "native/airplay"), { recursive: true });
  const key = () =>
    execFileSync(join(copy, "scripts/build-airplay-helper.sh"), ["--key", "mac-arm64"], {
      encoding: "utf8",
    }).trim();

  afterAll(() => rmSync(copy, { recursive: true, force: true }));

  it("holds still for the same inputs and moves with any of them", () => {
    const first = key();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(key()).toBe(first);
    const seen = new Set([first]);
    for (const file of [
      "native/airplay/Player.swift",
      "native/airplay/Info.plist",
      "scripts/build-airplay-helper.sh",
    ]) {
      appendFileSync(join(copy, file), "\n");
      seen.add(key());
    }
    expect(seen.size).toBe(4);
  });
});
