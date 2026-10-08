import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CI multimedia coverage", () => {
  it.each([
    ["complete", "all files"],
    ["pending", "receiver"],
    ["missing", "playlist-playback"],
    ["pending", "title-filter-playback"],
    ["missing", "title-filter-playback"],
    ["pending", "online-subtitle-playback"],
    ["missing", "online-subtitle-playback"],
  ] as const)("requires the complete behavioral result set: %s %s", (state, affected) => {
    const dir = mkdtempSync(join(tmpdir(), "mrstreamer-ci-results-"));
    try {
      const names = [
        "titles",
        "playback",
        "receiver",
        "output",
        "playlist-playback",
        "title-filter-playback",
        "online-subtitle-playback",
      ];
      const testResults = names
        .filter((name) => state !== "missing" || name !== affected)
        .map((name) => ({
          name: `/repo/apps/desktop/test/${name}.test.ts`,
          assertionResults: [
            {
              fullName: `${name} receives decoded picture`,
              status: state === "pending" && name === affected ? "pending" : "passed",
            },
          ],
        }));
      const path = join(dir, "results.json");
      writeFileSync(path, JSON.stringify({ testResults }));
      const run = spawnSync(
        process.execPath,
        ["apps/desktop/scripts/ci-multimedia-results.ts", path],
        { encoding: "utf8", timeout: 10_000 },
      );
      expect(run.error).toBeUndefined();
      expect(run.status === 0).toBe(state === "complete");
      if (state === "complete") {
        expect(run.stdout).toContain("title-filter-playback, 1 passed, no skips");
        expect(run.stdout).toContain("online-subtitle-playback, 1 passed, no skips");
      } else {
        expect(run.stderr).toContain("Required multimedia tests");
        expect(run.stderr).toContain(affected);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
