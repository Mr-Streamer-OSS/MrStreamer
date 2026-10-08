import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("CI multimedia coverage", () => {
  it.each(["complete", "skipped", "missing"] as const)(
    "requires the complete behavioral result set: %s",
    (state) => {
      const dir = mkdtempSync(join(tmpdir(), "mrstreamer-ci-results-"));
      try {
        const names = ["titles", "playback", "receiver", "output", "playlist-playback"];
        const testResults = names.map((name) => ({
          name: `/repo/apps/desktop/test/${name}.test.ts`,
          assertionResults: [
            {
              fullName: `${name} receives decoded picture`,
              status: state === "skipped" && name === "receiver" ? "pending" : "passed",
            },
          ],
        }));
        if (state === "missing") testResults.pop();
        const path = join(dir, "results.json");
        writeFileSync(path, JSON.stringify({ testResults }));
        const run = spawnSync(
          process.execPath,
          ["apps/desktop/scripts/ci-multimedia-results.ts", path],
          { encoding: "utf8", timeout: 10_000 },
        );
        expect(run.error).toBeUndefined();
        expect(run.status === 0).toBe(state === "complete");
        if (state === "complete") expect(run.stdout).toContain("no skips");
        else expect(run.stderr).toContain("Required multimedia tests");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
