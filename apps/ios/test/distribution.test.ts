import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Exercise the shipping CLI with a saved archive and an Xcode stand-in, without Apple access. */
function candidate(options: { fresh?: boolean; environment?: NodeJS.ProcessEnv } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ios-distribution-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, options.fresh ? "build" : "build/MrStreamer.xcarchive"), {
    recursive: true,
  });
  cpSync(
    join(import.meta.dirname, "../scripts/testflight.sh"),
    join(root, "scripts/testflight.sh"),
  );
  writeFileSync(join(root, ".gitignore"), "build/\n");
  writeFileSync(
    join(root, "bin/xcodebuild"),
    "#!/bin/sh\ncp build/ExportOptions.plist build/called.plist\n",
    { mode: 0o755 },
  );
  writeFileSync(join(root, "bin/xcbeautify"), "#!/bin/sh\ncat\n", { mode: 0o755 });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = (message: string) => {
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      message,
    );
  };
  commit("candidate");
  if (!options.fresh) {
    writeFileSync(join(root, "build/source.txt"), `${git("rev-parse", "HEAD")}\n`);
    const bundle = "build/MrStreamer.xcarchive/main.jsbundle";
    writeFileSync(join(root, bundle), "fixture archive bytes");
    writeFileSync(
      join(root, "build/archive.sha256"),
      `${createHash("sha256").update("fixture archive bytes").digest("hex")}  ${bundle}\n`,
    );
  }
  return {
    run: (...args: string[]) =>
      spawnSync("bash", ["scripts/testflight.sh", ...args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${join(root, "bin")}:${process.env["PATH"]}`,
          APPLE_TEAM_ID: "ABCDEFGHIJ",
          IOS_PROVISIONING_PROFILE: "12345678-1234-1234-1234-123456789abc",
          ...options.environment,
        },
      }),
    plist: () => readFileSync(join(root, "build/called.plist"), "utf8"),
    changeBundle: () =>
      writeFileSync(join(root, "build/MrStreamer.xcarchive/main.jsbundle"), "changed bytes"),
    orphanMap: () => writeFileSync(join(root, "build/main.jsbundle.map"), "retained map"),
    map: () => readFileSync(join(root, "build/main.jsbundle.map"), "utf8"),
    changeSource: () => {
      writeFileSync(join(root, "changed.txt"), "another source");
      commit("changed");
    },
  };
}

it.each(["app-store", "internal-only"])(
  "exports %s locally with explicit audience and preserved version",
  (intent) => {
    const c = candidate();
    const result = c.run("export", intent);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(c.plist()).toContain("<key>destination</key><string>export</string>");
    expect(c.plist()).toContain("<key>method</key><string>app-store-connect</string>");
    expect(c.plist()).toContain(
      `<key>testFlightInternalTestingOnly</key><${intent === "internal-only" ? "true" : "false"}/>`,
    );
    expect(c.plist()).toContain("<key>manageAppVersionAndBuildNumber</key><false/>");
  },
);

it("requires an explicit intent for export and upload", () => {
  const c = candidate();
  for (const args of [["export"], ["upload"], ["upload", "public"]]) {
    const result = c.run(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  }
});

it("refuses an archive changed after its source binding", () => {
  const c = candidate();
  c.changeBundle();
  expect(c.run("export", "app-store").status).not.toBe(0);
});

it("requires a new archive when committed source changes", () => {
  const c = candidate();
  c.changeSource();
  const result = c.run("export", "app-store");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("No archive of this commit");
});

it("requires production inputs before starting an archive", () => {
  const c = candidate({ fresh: true, environment: { EXPO_PUBLIC_TMDB_KEY: "" } });
  const result = c.run("archive");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Load the approved production");
});

it("refuses fixture overrides in distribution archives", () => {
  for (const name of [
    "EXPO_PUBLIC_TMDB_API",
    "EXPO_PUBLIC_PROOF_URL",
    "EXPO_PUBLIC_MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT",
  ]) {
    const c = candidate({ fresh: true, environment: { [name]: "http://127.0.0.1:8080" } });
    const result = c.run("archive");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Fixture overrides are not allowed");
  }
});

it("preserves a retained map when the archive has already been moved", () => {
  const c = candidate({ fresh: true });
  c.orphanMap();
  const result = c.run("archive");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("Candidate files already exist");
  expect(c.map()).toBe("retained map");
});
