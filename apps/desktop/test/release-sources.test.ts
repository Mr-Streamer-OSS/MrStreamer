import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { pluginProblems } from "../scripts/installer-plugins.ts";
import { prepare } from "../scripts/release-sources.ts";
import { tempDir } from "./support.ts";

describe("preparing a release's sources", () => {
  it("keeps a download that matches its pinned SHA-256 and refuses one that doesn't", async () => {
    const upstream = join(await tempDir(), "Codec_1.zip");
    await writeFile(upstream, "the codec's source");
    const url = pathToFileURL(upstream).href;
    const sha256 = createHash("sha256").update("the codec's source").digest("hex");
    const folder = await tempDir();

    const kept = await prepare({ file: "codec-1.zip", url, sha256 }, folder);

    expect(kept).toBe(join(folder, "codec-1.zip"));
    expect(await readFile(kept, "utf8")).toBe("the codec's source");
    await expect(
      prepare({ file: "changed-1.zip", url, sha256: "0".repeat(64) }, folder),
    ).rejects.toThrow(`has SHA-256 ${sha256}, not the pinned ${"0".repeat(64)}`);
    expect(existsSync(join(folder, "changed-1.zip"))).toBe(false);
  });

  it("archives a repository at its pinned commit, not at what came after", async () => {
    const repository = await tempDir();
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
        { encoding: "utf8" },
      ).trim();
    git("init", "-q");
    await writeFile(join(repository, "codec.c"), "the pinned source");
    git("add", ".");
    git("commit", "-qm", "Pinned");
    const commit = git("rev-parse", "HEAD");
    await writeFile(join(repository, "codec.c"), "a later change");
    git("commit", "-qam", "Later");
    const folder = await tempDir();

    const archive = await prepare(
      { file: `codec-${commit}.tar.gz`, git: repository, commit },
      folder,
    );

    const tar = gunzipSync(await readFile(archive)).toString("latin1");
    expect(tar).toContain(`codec-${commit}/codec.c`);
    expect(tar).toContain("the pinned source");
    expect(tar).not.toContain("a later change");
    await expect(
      prepare({ file: "missing.tar.gz", git: repository, commit: "0".repeat(40) }, folder),
    ).rejects.toThrow();
    expect(existsSync(join(folder, "missing.tar.gz"))).toBe(false);
  });
});

describe("checking the Windows setup's plug-ins", () => {
  it("reports a plug-in without a notice, a changed one and a missing one", () => {
    const reviewed = { "System.dll": "aa", "StdUtils.dll": "bb", "WinShell.dll": "cc" };

    expect(pluginProblems("setup", reviewed, reviewed)).toEqual([]);
    expect(
      pluginProblems(
        "setup",
        { "System.dll": "aa", "StdUtils.dll": "ee", "UAC.dll": "dd" },
        reviewed,
      ),
    ).toEqual([
      "StdUtils.dll in the setup has SHA-256 ee, not the reviewed one.",
      "The setup carries UAC.dll, which has no notice.",
      "The setup no longer carries WinShell.dll.",
    ]);
  });
});
